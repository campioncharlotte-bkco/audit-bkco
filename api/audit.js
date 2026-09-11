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
      // chevauchement et non inclusion : une journée fiscale qui déborde sur
      // le mois suivant rendait l'import invisible dans sa propre checklist
      sb(`imports?restaurant_id=in.(${restos.join(",")})&periode_debut=lte.${fin}`
        + `&periode_fin=gte.${debut}&select=*&order=depose_le.desc`)
    ]);
    // Quatre rapports ne portent aucune date : leur période vient de
    // l'écran de dépôt, donc une erreur de mois est possible. On ne le
    // signale QUE si le mois où ils sont rangés ne contient aucune
    // déclaration de caisse : sans caisses, ces chiffres ne se rattachent
    // à rien et le dépôt est presque sûrement égaré.
    //
    // Pour les rapports datés, la période est lue dans le fichier : un
    // dépôt sous mai est un dépôt de mai. Le signaler reviendrait à
    // proposer de défaire du travail correct — c'est ce que faisait la
    // première version de ce contrôle.
    const SANS_DATE = ["FLUX_CAISSIERS_1", "FLUX_CAISSIERS_2", "TICKETS_NON_PAYANTS",
                       "SYNTHESE_CA", "FLUX_RESP_1"];
    const ailleurs = {};
    if (restos.length === 1) {
      const [autres, moisAvecCaisses] = await Promise.all([
        sb(`imports?restaurant_id=eq.${restos[0]}&statut=eq.OK`
          + `&type_rapport_code=in.(${SANS_DATE.join(",")})`
          + `&or=(periode_debut.gt.${fin},periode_fin.lt.${debut})`
          + `&select=id,type_rapport_code,periode_debut,periode_fin,nb_lignes`
          + `&order=periode_debut.desc&limit=200`),
        sb(`v_caisses_ecarts?restaurant_id=eq.${restos[0]}&select=mois`)
      ]);
      const avecCaisses = new Set(moisAvecCaisses.map(m => String(m.mois).slice(0, 7)));
      autres.forEach(function (i) {
        const m = String(i.periode_debut).slice(0, 7);
        if (avecCaisses.has(m)) return;          // mois cohérent, rien à signaler
        const e = ailleurs[i.type_rapport_code];
        // la Synthèse CA compte neuf fichiers pour un seul rapport
        if (!e) ailleurs[i.type_rapport_code] = { ...i, fichiers: 1 };
        else if (String(e.periode_debut).slice(0, 7) === m) {
          e.fichiers++;
          e.nb_lignes = (Number(e.nb_lignes) || 0) + (Number(i.nb_lignes) || 0);
        }
      });
    }

    return {
      types, imports, ailleurs,
      manquants: types.filter(t => t.obligatoire &&
        !imports.some(i => i.type_rapport_code === t.code && i.statut === "OK"))
    };
  },

  // Retirer un dépôt. Le retrait porte sur le RAPPORT et le MOIS, pas sur
  // un identifiant : la Synthèse CA compte neuf fichiers, donc neuf lignes
  // d'import pour un seul rapport. Retirer la première en laissait huit.
  async retirerDepot({ restaurant_id, type, mois }, ctx) {
    const rid = Number(restaurant_id);
    if (!ctx.depot.includes(rid)) return { erreur: "Dépôt non autorisé sur ce restaurant." };
    if (!type || !mois) return { erreur: "Rapport ou mois manquant." };

    const debut = String(mois).slice(0, 7) + "-01";
    const d = new Date(debut);
    const suivant = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10);

    const cibles = await sb(`imports?restaurant_id=eq.${rid}`
      + `&type_rapport_code=eq.${encodeURIComponent(type)}`
      + `&periode_debut=gte.${debut}&periode_debut=lt.${suivant}`
      + `&select=id,nb_lignes,periode_debut,periode_fin`);
    if (!cibles.length) return { erreur: "Aucun dépôt à retirer pour ce mois." };

    // Les tables mensuelles cumulées sont alimentées en upsert par mois et
    // par badge : les lignes ne partent pas avec l'import, il faut les
    // effacer explicitement.
    const cumulees = { FLUX_CAISSIERS_1: "flux_caissiers", FLUX_CAISSIERS_2: "flux_caissiers",
                       TICKETS_NON_PAYANTS: "tickets_non_payants",
                       FLUX_RESP_1: "flux_responsables" };
    if (cumulees[type])
      await sb(`${cumulees[type]}?restaurant_id=eq.${rid}&mois=eq.${debut}`,
        { method: "DELETE", prefer: "return=minimal" });

    await sb(`imports?id=in.(${cibles.map(c => c.id).join(",")})`,
      { method: "DELETE", prefer: "return=minimal" });

    return { ok: true, type, mois: debut, fichiers: cibles.length,
             nb_lignes: cibles.reduce((t, c) => t + (Number(c.nb_lignes) || 0), 0) };
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

  // Écran d'accueil : un chiffre par restaurant, pour savoir où aller
  // avant même d'entrer. Une seule requête pour tout le périmètre.
  async accueil(_, ctx) {
    if (!ctx.lecture.length) return { restaurants: [] };
    const f = `restaurant_id=in.(${ctx.lecture.join(",")})`;
    const depuis = new Date();
    depuis.setMonth(depuis.getMonth() - 3);
    const [restos, ecarts] = await Promise.all([
      sb(`restaurants?id=in.(${ctx.lecture.join(",")})&select=id,nom,code_cash&order=nom`),
      sb(`v_ecarts_sessions?${f}&compense=is.false`
        + `&date_fiscale=gte.${depuis.toISOString().slice(0, 10)}`
        + `&select=restaurant_id,date_fiscale,ecart_mesure,echeance_camera&limit=2000`)
    ]);
    const auj = new Date();
    return {
      restaurants: restos.map(function (r) {
        const l = ecarts.filter(e => e.restaurant_id === r.id);
        const mois = [...new Set(l.map(e => String(e.date_fiscale).slice(0, 7)))].sort().pop();
        const duMois = l.filter(e => String(e.date_fiscale).slice(0, 7) === mois);
        return { ...r,
          dernier_mois: mois || null,
          ecarts: duMois.length,
          total: Math.round(duMois.reduce((t, e) => t + Number(e.ecart_mesure || 0), 0) * 100) / 100,
          urgents: l.filter(e => e.echeance_camera && new Date(e.echeance_camera) >= auj).length };
      })
    };
  },

  // Les comptages en manque, et rien d'autre. Un seul dénominateur pour
  // tout l'écran : les sessions dont le manquant espèces dépasse 20 € et
  // n'est pas repris par un autre mode de règlement. Les totaux affichés
  // correspondent donc toujours au détail listé en dessous — ce n'était
  // pas le cas de la version précédente, qui mélangeait deux populations.
  async caisses({ restaurant_id, mois }, ctx) {
    const rid = Number(restaurant_id);
    if (!dansPerimetre(ctx, rid)) throw new Error("Hors périmètre");

    const [parMois, ids] = await Promise.all([
      sb(`v_caisses_ecarts?restaurant_id=eq.${rid}&select=mois&order=mois.desc`),
      sb(`v_identites?restaurant_id=eq.${rid}&select=*`)
    ]);
    const moisDispo = [...new Set(parMois.map(l => l.mois))].sort().reverse();
    const m = mois || moisDispo[0] || null;
    const noms = {};
    ids.forEach(i => noms[i.badge_code] = i.nom_affiche);
    if (!m) return { mois: null, mois_disponibles: [], noms, sessions: [], compensees: [] };

    const [brutes, shifts] = await Promise.all([
      sb(`v_ecarts_sessions?restaurant_id=eq.${rid}`
        + `&date_fiscale=gte.${m.slice(0, 7)}-01&date_fiscale=lte.${finDuMois(m)}`
        + `&select=*&order=ecart_especes.asc`),
      sb(`v_shifts_jour?restaurant_id=eq.${rid}`
        + `&date_fiscale=gte.${m.slice(0, 7)}-01&date_fiscale=lte.${finDuMois(m)}&select=*`)
    ]);

    // Un manquant sur une caisse peut être repris par une autre caisse du
    // même service : titre restaurant ventilé au mauvais endroit, par
    // exemple. Sans ce total, l'application signale une perte là où il n'y
    // a qu'une erreur de saisie entre deux caisses.
    const parShift = {};
    shifts.forEach(x => parShift[`${x.date_fiscale}|${x.shift}`] = x);

    const visibles = brutes
      .filter(s => !ctx.masques.includes(s.badge_code)
                && !ctx.masques.includes(s.responsable))
      .map(function (s) {
        const sh = parShift[`${s.date_fiscale}|${s.shift}`] || null;
        const service = sh ? Number(sh.ecart_global) : null;
        const manquant = Math.abs(Number(s.ecart_especes) || 0);
        // Le SIGNE compte autant que l'ampleur. Un service en excédent
        // pendant qu'une caisse manque est le cas de ventilation par
        // excellence : l'argent est sur une autre caisse. Ma première
        // version ne regardait que la valeur absolue et classait « manque
        // réellement » un service à +60 € — l'inverse de la réalité.
        return { ...s,
          service_ecart: service,
          service_caisses: sh ? sh.caisses : null,
          service_lecture: service === null ? null
            : service > -10 ? "REPRIS"
            : Math.abs(service) < manquant * 0.5 ? "PARTIEL"
            : "MANQUE" };
      });

    return {
      mois: m, mois_disponibles: moisDispo, noms,
      sessions: visibles.filter(s => !s.compense),
      compensees: visibles.filter(s => s.compense)
    };
  },

  // Le détail des 23 modes de règlement d'une session : exactement le
  // tableau que le directeur a sous les yeux dans Cash Système. C'est là
  // que se lit la différence entre un manquant et une ventilation.
  async reglements({ restaurant_id, session_id }, ctx) {
    const rid = Number(restaurant_id);
    if (!dansPerimetre(ctx, rid)) throw new Error("Hors périmètre");
    // on repart de l'identifiant de session : faire transiter la caisse et
    // l'horodatage par un attribut HTML cassait le bouton
    const [e] = await sb(`v_ecarts_sessions?id=eq.${Number(session_id)}`
      + `&select=restaurant_id,caisse,fin_session`);
    if (!e || e.restaurant_id !== rid) throw new Error("Session introuvable");
    const lignes = await sb(`reglements_session?restaurant_id=eq.${rid}`
      + `&caisse=eq.${encodeURIComponent(e.caisse)}`
      + `&fin_session=eq.${encodeURIComponent(e.fin_session)}`
      + `&select=*&order=reglement.asc`);
    // on ne montre que ce qui bouge : vingt lignes à zéro n'apprennent rien
    const utiles = lignes.filter(l => Math.abs(Number(l.ecart) || 0) > 0.01
                                   || Math.abs(Number(l.theorique) || 0) > 0.01
                                   || Math.abs(Number(l.declare) || 0) > 0.01);
    const total = lignes.filter(l => l.reglement !== "REPAS EMPLOYE")
      .reduce((t, l) => t + (Number(l.ecart) || 0), 0);
    return { lignes: utiles, total: Math.round(total * 100) / 100,
             nb_modes: lignes.length };
  },

  // Ce qui s'est passé sur la caisse pendant la session où l'argent a
  // manqué. Chargé au clic, jamais avec la liste : sur un mois entier,
  // rapatrier le contexte de toutes les sessions serait inutile et lent.
  async contexte({ session_id, restaurant_id }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    const [bornes] = await sb(`v_bornes_session?id=eq.${Number(session_id)}&select=*`);
    if (!bornes || bornes.restaurant_id !== Number(restaurant_id))
      throw new Error("Session introuvable");
    const ops = await sb(`v_operations_session?session_id=eq.${Number(session_id)}`
      + `&select=*&order=horodate.asc`);
    return { bornes, operations: ops };
  },

  // Où chacun se situe. Sur toute la période chargée, pas sur un mois :
  // un mauvais mois isolé ne dit rien, c'est la répétition qui parle.
  // Le taux est le seul chiffre comparable — quelqu'un qui valide 180
  // caisses accumule mécaniquement plus d'écarts que celui qui en valide 40.
  async encadrants({ restaurant_id }, ctx) {
    const rid = Number(restaurant_id);
    if (!dansPerimetre(ctx, rid)) throw new Error("Hors périmètre");
    const [suivi, faits, ids] = await Promise.all([
      sb(`v_encadrants_mois?restaurant_id=eq.${rid}&select=responsable,nom_affiche,mois,sessions`),
      sb(`v_ecarts_sessions?restaurant_id=eq.${rid}&compense=is.false&select=*&limit=3000`),
      sb(`v_identites?restaurant_id=eq.${rid}&select=*`)
    ]);
    const noms = {};
    ids.forEach(i => noms[i.badge_code] = i.nom_affiche);

    const par = {};
    suivi.forEach(function (l) {
      if (ctx.masques.includes(l.responsable)) return;
      const e = par[l.responsable] || (par[l.responsable] = {
        code: l.responsable, nom: l.nom_affiche || noms[l.responsable] || l.responsable,
        validees: 0, mois: new Set(), en_manque: 0, total: 0, pire: 0, urgents: 0,
        dernier: null });
      e.validees += Number(l.sessions) || 0;
      e.mois.add(l.mois);
    });
    const auj = new Date();
    faits.forEach(function (f) {
      const e = par[f.responsable];
      if (!e) return;
      e.en_manque++;
      e.total += Number(f.ecart_mesure) || 0;
      e.pire = Math.min(e.pire, Number(f.ecart_mesure) || 0);
      if (f.echeance_camera && new Date(f.echeance_camera) >= auj) e.urgents++;
      if (!e.dernier || f.date_fiscale > e.dernier) e.dernier = f.date_fiscale;
    });

    const liste = Object.values(par).map(e => ({
      ...e, mois: e.mois.size,
      total: Math.round(e.total * 100) / 100,
      taux: e.validees ? Math.round(e.en_manque / e.validees * 1000) / 10 : null
    })).sort((a, b) => (b.taux || 0) - (a.taux || 0) || a.total - b.total);

    const totalValidees = liste.reduce((t, e) => t + e.validees, 0);
    const totalManque = liste.reduce((t, e) => t + e.en_manque, 0);
    return { encadrants: liste, noms,
             taux_restaurant: totalValidees
               ? Math.round(totalManque / totalValidees * 1000) / 10 : null,
             validees: totalValidees, en_manque: totalManque };
  },

  // Fiche d'un responsable : sa série mensuelle et tous ses comptages en
  // manque. Le taux est le seul chiffre comparable dans le temps — le
  // nombre brut suit le volume de caisses validées, qui varie d'un mois
  // à l'autre selon les plannings.
  async personne({ restaurant_id, code }, ctx) {
    const rid = Number(restaurant_id);
    if (!dansPerimetre(ctx, rid)) throw new Error("Hors périmètre");
    if (ctx.masques.includes(code)) throw new Error("Hors périmètre");
    const cible = encodeURIComponent(code);
    const [faits, suivi, ids] = await Promise.all([
      sb(`v_ecarts_sessions?restaurant_id=eq.${rid}&responsable=eq.${cible}`
        + `&compense=is.false&select=*&order=date_fiscale.desc`),
      sb(`v_encadrants_mois?restaurant_id=eq.${rid}&responsable=eq.${cible}`
        + `&select=mois,sessions,nom_affiche&order=mois.asc`),
      sb(`v_identites?restaurant_id=eq.${rid}&select=*`)
    ]);
    const noms = {};
    ids.forEach(i => noms[i.badge_code] = i.nom_affiche);

    const serie = suivi.map(function (l) {
      const duMois = faits.filter(f => String(f.date_fiscale).slice(0, 7) === l.mois.slice(0, 7));
      const total = duMois.reduce((t, f) => t + Number(f.ecart_especes || 0), 0);
      return {
        mois: l.mois,
        validees: Number(l.sessions) || 0,
        en_manque: duMois.length,
        total: Math.round(total * 100) / 100,
        pire: duMois.length ? Math.min(...duMois.map(f => Number(f.ecart_especes))) : 0,
        taux: Number(l.sessions) ? Math.round(duMois.length / Number(l.sessions) * 1000) / 10 : null
      };
    });

    return {
      code,
      nom: (suivi[0] && suivi[0].nom_affiche) || noms[code] || code,
      serie, noms,
      faits: faits.slice(0, 60),
      nb_faits: faits.length,
      total: Math.round(faits.reduce((t, f) => t + Number(f.ecart_especes || 0), 0) * 100) / 100
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

  // Gestion des restaurants. Étaples arrive, et il ne doit pas falloir
  // passer par l'éditeur SQL pour ouvrir un site.
  async restaurants(_, ctx) {
    if (ctx.role !== "DG") return { erreur: "Réservé à la direction générale." };
    const [liste, types] = await Promise.all([
      sb("restaurants?select=*&order=nom"),
      sb("restaurants?select=type_implantation")
    ]);
    return { restaurants: liste,
             types: [...new Set(types.map(t => t.type_implantation).filter(Boolean))].sort() };
  },

  async majRestaurant({ id, code_cash, nom, type_implantation, actif }, ctx) {
    if (ctx.role !== "DG") return { erreur: "Réservé à la direction générale." };
    if (!nom || !String(nom).trim()) return { erreur: "Le nom est obligatoire." };
    const corps = { nom: String(nom).trim(),
                    code_cash: code_cash ? String(code_cash).trim() : null,
                    type_implantation: type_implantation || null,
                    actif: actif === undefined ? true : !!actif };
    if (id) {
      await sb(`restaurants?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(corps) });
      return { ok: true, id };
    }
    const [r] = await sb("restaurants", { method: "POST", body: JSON.stringify(corps) });
    // sans périmètre, un restaurant créé reste invisible de tous, y compris
    // de celui qui vient de le créer : on ouvre l'accès à l'encadrement.
    const encadrement = await sb(
      "utilisateurs?role=in.(DG,SUPERVISEUR,CDG)&actif=is.true&select=id,role");
    if (encadrement.length)
      await sb("perimetres", { method: "POST", prefer: "return=minimal",
        body: JSON.stringify(encadrement.map(u => ({
          utilisateur_id: u.id, restaurant_id: r.id,
          peut_deposer: true, peut_lire: true, peut_cloturer: true }))) });
    return { ok: true, id: r.id, perimetres_ouverts: encadrement.length };
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

  // La table des salariés est le pivot : sans elle, aucun écart n'est
  // nominatif. On sépare les encadrants des équipiers, parce qu'ils ne
  // demandent pas le même travail. Le nom complet d'un encadrant figure
  // en clair dans la colonne du valideur de la Déclaration de caisse
  // (« BAUDRY Laurence ») : sa fiche se pré-remplit toute seule. Un
  // équipier n'apparaît que sous son trigramme, il faut le saisir.
  async salaries({ restaurant_id }, ctx) {
    if (!dansPerimetre(ctx, restaurant_id)) throw new Error("Hors périmètre");
    const [liste, flux, sessions] = await Promise.all([
      sb(`salaries?restaurant_id=eq.${restaurant_id}&select=*&order=badge_code`),
      sb(`flux_caissiers?restaurant_id=eq.${restaurant_id}&select=badge_code`),
      sb(`sessions_caisse?restaurant_id=eq.${restaurant_id}`
        + `&select=badge_code,valide_par&limit=5000`)
    ]);
    const connus = new Set(liste.map(s => s.badge_code));

    // même règle que Cash Système : 4 lettres du nom + 3 du prénom
    const badge = v => {
      const t = String(v || "").trim();
      if (!t) return null;
      if (t.indexOf(" ") < 0) return t.toUpperCase();
      const [nom, prenom] = t.split(/\s+/);
      return (nom.slice(0, 4) + (prenom || "").slice(0, 3)).toUpperCase();
    };

    const encadrants = new Map();   // badge -> nom complet le plus fréquent
    const equipiers = new Set();
    sessions.forEach(function (s) {
      const v = s.valide_par && String(s.valide_par).trim();
      if (v) {
        const b = badge(v);
        if (b && !encadrants.has(b)) encadrants.set(b, v.indexOf(" ") > 0 ? v : null);
      }
      if (s.badge_code) equipiers.add(String(s.badge_code).trim().toUpperCase());
    });
    flux.forEach(f => { if (f.badge_code) equipiers.add(String(f.badge_code).trim().toUpperCase()); });

    return {
      salaries: liste,
      inconnus_encadrants: [...encadrants.entries()]
        .filter(([b]) => b && !connus.has(b))
        .map(([badge_code, nom_propose]) => ({ badge_code, nom_propose }))
        .sort((a, b) => a.badge_code.localeCompare(b.badge_code)),
      inconnus_equipiers: [...equipiers]
        .filter(b => b && !connus.has(b) && !encadrants.has(b))
        .sort()
    };
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
