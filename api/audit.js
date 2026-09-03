/* =====================================================================
   AUDIT BKCO — api/audit.js
   Toutes les lectures passent ici. Le navigateur n'accède jamais à
   Supabase en direct : c'est ce qui rend le cloisonnement réel plutôt
   que cosmétique. Chaque requête applique le périmètre hiérarchique et
   masque les anomalies portant sur le badge de l'utilisateur ou de sa
   hiérarchie ascendante.
   ===================================================================== */

const crypto = require("crypto");
const URL_SB = process.env.SUPABASE_URL;
const KEY_SB = process.env.SUPABASE_SERVICE_KEY;

/* ---------- accès Supabase ---------- */

async function sb(chemin, options = {}) {
  const r = await fetch(`${URL_SB}/rest/v1/${chemin}`, {
    ...options,
    headers: {
      apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} : ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}
const rpc = (fn, args) =>
  sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

/* ---------- jetons de session ---------- */

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = d => crypto.createHmac("sha256", KEY_SB).update(d).digest("base64url");

function creerJeton(uid, heures = 12) {
  const p = b64({ uid, exp: Date.now() + heures * 3600e3 });
  return `${p}.${sign(p)}`;
}
function lireJeton(jeton) {
  if (!jeton || !jeton.includes(".")) return null;
  const [p, s] = jeton.split(".");
  if (sign(p) !== s) return null;
  try {
    const d = JSON.parse(Buffer.from(p, "base64url").toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

/* ---------- contexte de l'utilisateur ---------- */

async function contexte(uid) {
  const [u] = await sb(`utilisateurs?id=eq.${uid}&select=id,nom,role,email,actif`);
  if (!u || !u.actif) throw new Error("Utilisateur inactif");
  const perim = await rpc("perimetre_utilisateur", { uid });
  const masques = (await rpc("badges_masques", { uid })).map(b => b.badge_code);
  return {
    ...u,
    perimetre: perim,
    lecture: perim.filter(p => p.peut_lire).map(p => p.restaurant_id),
    depot: perim.filter(p => p.peut_deposer).map(p => p.restaurant_id),
    cloture: perim.filter(p => p.peut_cloturer).map(p => p.restaurant_id),
    masques
  };
}
const dansPerimetre = (ctx, id, droit = "lecture") => ctx[droit].includes(Number(id));

/* ---------- actions ---------- */

const actions = {

  async connexion({ email, pin }) {
    const [r] = await rpc("verifier_pin", { p_email: email, p_pin: pin });
    if (r.statut === "VERROUILLE")
      return { erreur: "Compte verrouillé 15 minutes après 5 tentatives." };
    if (r.statut !== "OK") return { erreur: "Identifiants incorrects." };
    return { jeton: creerJeton(r.id), utilisateur: { id: r.id, nom: r.nom, role: r.role } };
  },

  async moi(_, ctx) {
    const restos = await sb("restaurants?select=id,code_cash,nom,type_implantation&actif=is.true&order=nom");
    return {
      utilisateur: { id: ctx.id, nom: ctx.nom, role: ctx.role },
      restaurants: restos.filter(r => ctx.lecture.includes(r.id) || ctx.depot.includes(r.id)),
      droits: { depot: ctx.depot, lecture: ctx.lecture, cloture: ctx.cloture }
    };
  },

  // Cockpit : ratios du mois par restaurant, comparés à la moyenne réseau
  // du même type d'implantation. Les taux sont en base TTC (comme les MN),
  // les montants en HT.
  async cockpit({ mois }, ctx) {
    if (!ctx.lecture.length) return { restaurants: [] };
    const f = `restaurant_id=in.(${ctx.lecture.join(",")})`;
    const [ratios, restos, mn, seuils] = await Promise.all([
      sb(`ratios_mensuels?${f}&mois=eq.${mois}&canal=eq.TOTAL_CPT_DRIVE&select=*`),
      sb(`restaurants?select=id,nom,type_implantation`),
      sb(`moyennes_reseau?mois=eq.${mois}&select=*`),
      sb(`seuils?select=*`)
    ]);
    const parResto = new Map(restos.map(r => [r.id, r]));
    return {
      mois,
      seuils,
      restaurants: ratios.map(r => {
        const resto = parResto.get(r.restaurant_id);
        const ref = t => mn.find(m => m.ratio === t &&
          (m.type_implantation === resto?.type_implantation || m.type_implantation === "TOTAL"))?.valeur ?? null;
        return { ...r, nom: resto?.nom, type_implantation: resto?.type_implantation,
                 references: { CO: ref("CO"), ANNULATIONS: ref("ANNULATIONS"),
                               REMISES_50: ref("REMISES_50"),
                               CORRECTIONS_COMPTOIR: ref("CORRECTIONS_COMPTOIR"),
                               CORRECTIONS_DRIVE: ref("CORRECTIONS_DRIVE") } };
      })
    };
  },

  // File d'anomalies, triée par échéance caméra puis par score : ce qui
  // va expirer d'abord, puisque les images ne sont gardées que 14 jours.
  async anomalies({ statut = "A_VERIFIER", restaurant_id, frequence }, ctx) {
    if (!ctx.lecture.length) return { anomalies: [] };
    const restos = restaurant_id && dansPerimetre(ctx, restaurant_id)
      ? [Number(restaurant_id)] : ctx.lecture;
    let q = `anomalies?restaurant_id=in.(${restos.join(",")})&select=*`
          + `&order=echeance_camera.asc.nullslast,score.desc&limit=300`;
    if (statut !== "TOUS") q += `&statut=eq.${statut}`;
    if (frequence) q += `&frequence=eq.${frequence}`;
    const lignes = await sb(q);
    // masquage de la chaîne hiérarchique de l'utilisateur
    const visibles = lignes.filter(a => !a.badge_code || !ctx.masques.includes(a.badge_code));
    return { anomalies: visibles, masquees: lignes.length - visibles.length };
  },

  async anomalie({ id }, ctx) {
    const [a] = await sb(`anomalies?id=eq.${id}&select=*`);
    if (!a || !dansPerimetre(ctx, a.restaurant_id)) throw new Error("Hors périmètre");
    if (a.badge_code && ctx.masques.includes(a.badge_code)) throw new Error("Hors périmètre");
    const evts = await sb(`anomalie_evenements?anomalie_id=eq.${id}&select=*&order=cree_le.asc`);
    return { anomalie: a, evenements: evts };
  },

  // Un directeur documente, il ne clôt pas : seul peut_cloturer autorise
  // le passage aux statuts finaux.
  async majAnomalie({ id, statut, commentaire, type = "COMMENTAIRE" }, ctx) {
    const [a] = await sb(`anomalies?id=eq.${id}&select=*`);
    if (!a || !dansPerimetre(ctx, a.restaurant_id)) throw new Error("Hors périmètre");
    const finaux = ["EXPLIQUEE", "CONFIRMEE", "CLASSEE"];
    if (statut && finaux.includes(statut) && !dansPerimetre(ctx, a.restaurant_id, "cloture"))
      return { erreur: "Vous pouvez documenter cette anomalie, pas la clore." };
    if (commentaire)
      await sb("anomalie_evenements", { method: "POST", body: JSON.stringify(
        { anomalie_id: Number(id), auteur_id: ctx.id, type, contenu: commentaire }) });
    if (statut) {
      const maj = { statut };
      if (finaux.includes(statut)) { maj.cloture_par = ctx.id; maj.cloture_le = new Date().toISOString(); }
      await sb(`anomalies?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(maj) });
      await sb("anomalie_evenements", { method: "POST", body: JSON.stringify(
        { anomalie_id: Number(id), auteur_id: ctx.id, type: "CHGT_STATUT", contenu: statut }) });
    }
    return { ok: true };
  },

  // État des dépôts : la checklist suit l'ordre du menu AUDIT de Cash Système.
  async depots({ restaurant_id, debut, fin }, ctx) {
    const restos = restaurant_id ? [Number(restaurant_id)]
                                 : [...new Set([...ctx.depot, ...ctx.lecture])];
    if (!restos.length) return { depots: [] };
    const [types, imports] = await Promise.all([
      sb("types_rapport?actif=is.true&select=*&order=ordre_menu"),
      sb(`imports?restaurant_id=in.(${restos.join(",")})&periode_debut=gte.${debut}`
        + `&periode_fin=lte.${fin}&select=*&order=depose_le.desc`)
    ]);
    return {
      types, imports,
      manquants: types.filter(t => t.obligatoire &&
        !imports.some(i => i.type_rapport_code === t.code && i.statut === "OK"))
    };
  },

  // Libellés de remise jamais vus : à qualifier une fois. Sans ce garde-fou,
  // la roulette drive de juin 2026 aurait déclenché une alerte rouge à tort.
  async libellesAQualifier(_, ctx) {
    return { libelles: await sb(
      "libelles_remise?statut=eq.A_QUALIFIER&select=*&order=derniere_vue.desc") };
  },

  async qualifierLibelle({ id, statut, operation_id, neutralise, commentaire }, ctx) {
    if (!["DG", "SUPERVISEUR", "CDG"].includes(ctx.role))
      return { erreur: "Réservé à la direction et au contrôle de gestion." };
    const [maj] = await sb(`libelles_remise?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      statut, operation_id: operation_id || null,
      neutralise_ratio: !!neutralise, commentaire: commentaire || null,
      qualifie_par: ctx.id, qualifie_le: new Date().toISOString() }) });
    // un libellé jugé normal ne doit plus encombrer la file : les écarts
    // qu'il a produits se referment d'eux-mêmes
    let refermees = 0;
    if (maj && ["AUTORISE", "OPERATION"].includes(statut)) {
      const ouvertes = await sb(`anomalies?statut=eq.A_VERIFIER&ratio=eq.REMISES_50`
        + `&select=id,pieces`);
      const cibles = ouvertes.filter(a => a.pieces && a.pieces.libelle === maj.libelle);
      for (const a of cibles) {
        await sb(`anomalies?id=eq.${a.id}`, { method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ statut: "CLASSEE", cloture_par: ctx.id,
                                 cloture_le: new Date().toISOString() }) });
        await sb("anomalie_evenements", { method: "POST", prefer: "return=minimal",
          body: JSON.stringify({ anomalie_id: a.id, auteur_id: ctx.id, type: "CHGT_STATUT",
            contenu: statut === "OPERATION" ? "Opération commerciale déclarée"
                                            : "Remise qualifiée de normale" }) });
        refermees++;
      }
    }
    return { ok: true, refermees };
  },

  async ficheSalarie({ restaurant_id, badge_code }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    if (ctx.masques.includes(badge_code)) throw new Error("Hors périmètre");
    const [flux, tnp, tend, anos] = await Promise.all([
      sb(`flux_caissiers?restaurant_id=eq.${restaurant_id}&badge_code=eq.${badge_code}&select=*&order=mois`),
      sb(`tickets_non_payants?restaurant_id=eq.${restaurant_id}&badge_code=eq.${badge_code}&select=*&order=mois`),
      sb(`tendances?restaurant_id=eq.${restaurant_id}&badge_code=eq.${badge_code}&select=*&order=mois`),
      sb(`anomalies?restaurant_id=eq.${restaurant_id}&badge_code=eq.${badge_code}&select=*&order=cree_le.desc&limit=50`)
    ]);
    return { flux, tickets: tnp, tendances: tend, anomalies: anos };
  },

  /* --- administration, DG uniquement --- */

  async utilisateurs(_, ctx) {
    if (ctx.role !== "DG") return { erreur: "Réservé à la direction générale." };
    const [us, ps] = await Promise.all([
      sb("utilisateurs?select=id,nom,email,role,responsable_id,actif,derniere_connexion&order=nom"),
      sb("perimetres?select=*")
    ]);
    return { utilisateurs: us, perimetres: ps };
  },

  async creerUtilisateur({ nom, email, role, pin, responsable_id, perimetres }, ctx) {
    if (ctx.role !== "DG") return { erreur: "Réservé à la direction générale." };
    if (["DG", "SUPERVISEUR", "CDG"].includes(role) && String(pin).length < 6)
      return { erreur: "Un profil pouvant clore une anomalie exige un code d'au moins 6 chiffres." };
    if (String(pin).length < 4) return { erreur: "Code trop court." };
    const [u] = await sb("utilisateurs", { method: "POST", body: JSON.stringify(
      { nom, email, role, responsable_id: responsable_id || null, pin_hash: "x" }) });
    await rpc("definir_pin", { p_utilisateur: u.id, p_pin: String(pin) });
    if (perimetres?.length)
      await sb("perimetres", { method: "POST", body: JSON.stringify(
        perimetres.map(p => ({ utilisateur_id: u.id, restaurant_id: p.restaurant_id,
          peut_deposer: !!p.peut_deposer, peut_lire: !!p.peut_lire,
          peut_cloturer: !!p.peut_cloturer })) ) });
    return { ok: true, id: u.id };
  },

  async majUtilisateur({ id, actif, role, responsable_id, pin, perimetres }, ctx) {
    if (ctx.role !== "DG") return { erreur: "Réservé à la direction générale." };
    const maj = {};
    if (actif !== undefined) maj.actif = !!actif;
    if (role) maj.role = role;
    if (responsable_id !== undefined) maj.responsable_id = responsable_id || null;
    if (Object.keys(maj).length)
      await sb(`utilisateurs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(maj) });
    if (pin) await rpc("definir_pin", { p_utilisateur: Number(id), p_pin: String(pin) });
    if (perimetres) {
      await sb(`perimetres?utilisateur_id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      if (perimetres.length)
        await sb("perimetres", { method: "POST", body: JSON.stringify(
          perimetres.map(p => ({ utilisateur_id: Number(id), restaurant_id: p.restaurant_id,
            peut_deposer: !!p.peut_deposer, peut_lire: !!p.peut_lire,
            peut_cloturer: !!p.peut_cloturer })) ) });
    }
    return { ok: true };
  },

  async salaries({ restaurant_id }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    return { salaries: await sb(
      `salaries?restaurant_id=eq.${restaurant_id}&select=*&order=badge_code`) };
  },

  // Les badges sont construits en 4 lettres du nom + 3 du prénom
  // (BAUDRY Laurence -> BAUDLAU). L'app propose, le directeur valide :
  // c'est une proposition, jamais une déduction certaine.
  async majSalarie({ id, restaurant_id, badge_code, nom_complet, fonction, poste_habituel,
                     utilisateur_id, date_prise_poste }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    const corps = { restaurant_id, badge_code, nom_complet, fonction, poste_habituel,
                    utilisateur_id: utilisateur_id || null,
                    date_prise_poste: date_prise_poste || null, confiance_mapping: "VALIDE" };
    if (id) await sb(`salaries?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(corps) });
    else    await sb("salaries", { method: "POST", body: JSON.stringify(corps) });
    return { ok: true };
  }
};

/* ---------- routage ---------- */

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erreur: "POST attendu" });
  try {
    const corps = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { action, jeton, ...params } = corps;
    if (!actions[action]) return res.status(400).json({ erreur: "Action inconnue" });
    if (action === "connexion") return res.status(200).json(await actions.connexion(params));
    const session = lireJeton(jeton);
    if (!session) return res.status(401).json({ erreur: "Session expirée" });
    const ctx = await contexte(session.uid);
    return res.status(200).json(await actions[action](params, ctx));
  } catch (e) {
    return res.status(500).json({ erreur: String(e.message || e) });
  }
};
