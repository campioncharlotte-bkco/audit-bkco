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

// Dernier jour du mois dont on reçoit le premier jour ('2026-08-01').
function finDuMois(mois) {
  const an = Number(mois.slice(0, 4)), m = Number(mois.slice(5, 7));
  return `${mois.slice(0, 7)}-${String(new Date(an, m, 0).getDate()).padStart(2, "0")}`;
}

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
    // les rapports mélangent badges et noms complets : on renvoie de quoi
    // afficher un nom lisible plutôt qu'un trigramme
    const ids = await sb(`v_identites?restaurant_id=in.(${restos.join(",")})&select=*`);
    const noms = {};
    ids.forEach(i => noms[i.badge_code] = i.nom_affiche);
    return { anomalies: visibles, masquees: lignes.length - visibles.length, noms };
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

  // Libellés de remise. Sans ce garde-fou, la roulette drive de juin 2026
  // aurait déclenché une alerte rouge à tort. Une qualification doit rester
  // révisable : on se trompe, et un libellé change de sens d'une opération
  // à l'autre.
  async libelles({ statut }, ctx) {
    let q = "libelles_remise?select=*&order=derniere_vue.desc&limit=600";
    if (statut && statut !== "TOUS") q += `&statut=eq.${statut}`;
    const libelles = await sb(q);
    const tous = await sb("libelles_remise?select=statut");
    const compte = { A_QUALIFIER: 0, AUTORISE: 0, OPERATION: 0, NON_AUTORISE: 0 };
    tous.forEach(l => { compte[l.statut] = (compte[l.statut] || 0) + 1; });
    return { libelles, compte };
  },

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

  // Écarts de caisse : trois angles sur la même donnée.
  //   - par session : le fait daté, avec sa fenêtre caméra ;
  //   - par caisse  : le TAUX de sessions en écart, pas le cumul — sinon
  //     la caisse la plus utilisée ressort toujours en tête ;
  //   - par encadrant : l'écart moyen par session validée, même raison.
  // Les sessions dont le manquant espèces est repris par la CB ou le TPE
  // sont renvoyées à part : ce sont des erreurs de saisie, pas des trous.
  async caisses({ restaurant_id, mois }, ctx) {
    const restos = restaurant_id && dansPerimetre(ctx, restaurant_id)
      ? [Number(restaurant_id)] : ctx.lecture;
    if (!restos.length) return { caisses: [], sessions: [], compensees: [], encadrants: [] };
    const f = `restaurant_id=in.(${restos.join(",")})`;
    const [parCaisse, suivi, ecartsEnc, ids] = await Promise.all([
      sb(`v_caisses_ecarts?${f}&select=*&order=mois.desc`),
      sb(`v_encadrants_mois?${f}&select=*&order=mois.desc`),
      sb(`v_encadrants_ecarts?${f}&select=*`),
      sb(`v_identites?${f}&select=*`)
    ]);
    const moisDispo = [...new Set([...parCaisse.map(l => l.mois), ...suivi.map(l => l.mois)])]
      .sort().reverse();
    const m = mois || moisDispo[0] || null;
    const noms = {};
    ids.forEach(i => noms[i.badge_code] = i.nom_affiche);

    let brutes = [];
    if (m) {
      brutes = await sb(`v_ecarts_sessions?${f}&date_fiscale=gte.${m.slice(0, 7)}-01`
        + `&date_fiscale=lte.${finDuMois(m)}&select=*&order=date_fiscale.desc`);
      brutes = brutes.filter(s => !ctx.masques.includes(s.badge_code)
                               && !ctx.masques.includes(s.responsable));
    }

    return {
      mois: m,
      mois_disponibles: moisDispo,
      noms,
      caisses: parCaisse.filter(l => l.mois === m)
        .sort((a, b) => (Number(b.taux_lourdes) || 0) - (Number(a.taux_lourdes) || 0)),
      sessions: brutes.filter(s => !s.compense),
      compensees: brutes.filter(s => s.compense),
      encadrants: suivi.filter(l => l.mois === m && !ctx.masques.includes(l.responsable))
        .map(l => ({
          ...l,
          historique: suivi.filter(h => h.responsable === l.responsable
                                     && h.restaurant_id === l.restaurant_id)
                           .sort((x, y) => x.mois < y.mois ? -1 : 1),
          ecarts: ecartsEnc.find(e => e.responsable === l.responsable
                                   && e.restaurant_id === l.restaurant_id) || null
        }))
        .sort((x, y) => (x.ecart_par_session ?? 0) - (y.ecart_par_session ?? 0))
    };
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

  // La table des salariés est le pivot du dispositif : sans elle, aucune
  // anomalie n'est nominative. On renvoie donc aussi les badges vus dans
  // les données mais absents de la table — ce sont eux qui font apparaître
  // des trigrammes illisibles dans l'analyse.
  async salaries({ restaurant_id }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    const [liste, flux, sessions] = await Promise.all([
      sb(`salaries?restaurant_id=eq.${restaurant_id}&select=*&order=badge_code`),
      sb(`flux_caissiers?restaurant_id=eq.${restaurant_id}&select=badge_code`),
      sb(`sessions_caisse?restaurant_id=eq.${restaurant_id}&select=badge_code,valide_par&limit=3000`)
    ]);
    const connus = new Set(liste.map(s => s.badge_code));
    const vus = new Set();
    flux.forEach(f => { if (f.badge_code) vus.add(String(f.badge_code).trim().toUpperCase()); });
    sessions.forEach(s => {
      if (s.badge_code) vus.add(String(s.badge_code).trim().toUpperCase());
      const v = s.valide_par && String(s.valide_par).trim();
      if (v && v.indexOf(" ") < 0) vus.add(v.toUpperCase());
    });
    return { salaries: liste,
             inconnus: [...vus].filter(b => b && !connus.has(b)).sort() };
  },

  async supprimerSalarie({ id, restaurant_id }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    if (!["DG", "SUPERVISEUR", "CDG"].includes(ctx.role))
      return { erreur: "Réservé à la direction et au contrôle de gestion." };
    await sb(`salaries?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
    return { ok: true };
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
