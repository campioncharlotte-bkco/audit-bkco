/* =====================================================================
   AUDIT BKCO — api/import.js
   Traite un dépôt : parse, contrôle l'intégrité, insère, puis génère les
   anomalies datées de la période. Les anomalies hebdomadaires portent une
   échéance caméra (14 jours de rétention chez BKCO) : la file est triée
   par ce qui va expirer, pas par gravité supposée.
   ===================================================================== */

const crypto = require("crypto");
const { parser, recouperSynthese } = require("../parsers.js");

const URL_SB = process.env.SUPABASE_URL;
const KEY_SB = process.env.SUPABASE_SERVICE_KEY;

const RETENTION_CAMERA = 14;      // jours
const SEUIL_ECART_SESSION = 20;   // euros, écart de caisse jugé significatif
const DELAI_ANNULATION_H = 2;     // procédure BK : annuler aussitôt, 2h max en rush

async function sb(chemin, options = {}) {
  const r = await fetch(`${URL_SB}/rest/v1/${chemin}`, {
    ...options,
    headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation", ...(options.headers || {}) }
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} : ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = d => crypto.createHmac("sha256", KEY_SB).update(d).digest("base64url");
function lireJeton(j) {
  if (!j || !j.includes(".")) return null;
  const [p, s] = j.split(".");
  if (sign(p) !== s) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString());
        return d.exp > Date.now() ? d : null; } catch { return null; }
}

// PostgREST refuse un lot dont les objets n'ont pas exactement les mêmes
// clés, et JSON.stringify supprime les clés valant undefined. On aligne
// donc toutes les lignes sur l'union des colonnes rencontrées.
function homogeneiser(lignes) {
  const colonnes = new Set();
  lignes.forEach(l => Object.keys(l).forEach(k => { if (l[k] !== undefined) colonnes.add(k); }));
  return lignes.map(l => {
    const o = {};
    colonnes.forEach(k => o[k] = (l[k] === undefined ? null : l[k]));
    return o;
  });
}

const parLots = async (table, lignes, taille = 500) => {
  const plates = homogeneiser(lignes);
  for (let i = 0; i < plates.length; i += taille)
    await sb(table, { method: "POST", prefer: "return=minimal",
                      body: JSON.stringify(plates.slice(i, i + taille)) });
};
// Les rapports nomment tantôt par badge (BIENBEN), tantôt en clair
// (BIENAIME Benjamin) : on ramène tout au badge, construit en 4 lettres
// du nom + 3 du prénom.
function normaliserIdentite(v) {
  if (!v) return null;
  const t = String(v).trim();
  if (!t) return null;
  if (t.indexOf(" ") < 0) return t.toUpperCase();
  const [nom, prenom] = t.split(/\s+/);
  return (nom.slice(0, 4) + (prenom || "").slice(0, 3)).toUpperCase();
}
// Un manquant à la fermeture ne se lit pas comme un manquant de midi.
function momentShift(h) {
  if (!h) return null;
  const m = String(h).match(/T(\d{2}):/) || String(h).match(/\s(\d{2}):/);
  if (!m) return null;
  const heure = Number(m[1]);
  return heure < 12 ? "OUVERTURE" : heure < 18 ? "JOURNEE" : "FERMETURE";
}

const jours = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n);
                          return x.toISOString().slice(0, 10); };

/* ---------- dépôt ---------- */

async function deposer({ contenu, nom_fichier, restaurant_id, periode_debut, periode_fin,
                         nature = "COURANT" }, ctx) {
  if (!ctx.depot.includes(Number(restaurant_id)))
    return { erreur: "Vous ne pouvez pas déposer pour ce restaurant." };

  const p = parser(contenu, nom_fichier);
  if (p.erreur) return { erreur: p.erreur, entetes: p.entetes };

  const hash = crypto.createHash("sha256").update(contenu).digest("hex");
  const [doublon] = await sb(
    `imports?restaurant_id=eq.${restaurant_id}&fichier_hash=eq.${hash}&select=id,depose_le&limit=1`);
  if (doublon) return { erreur: `Fichier déjà déposé le ${doublon.depose_le.slice(0, 10)}.` };

  // La période est lue dans le fichier, jamais déclarée par le déposant :
  // c'est ce qui empêche un dépôt tronqué de passer pour complet.
  // Plusieurs rapports (flux caissiers, tickets non payants, responsable de
  // comptage, synthèse) ne portent aucune date : la période vient alors de
  // l'écran de dépôt. À défaut, on complète par le mois de la date connue.
  const debut = p.periode_debut || periode_debut;
  let fin = p.periode_fin || periode_fin;
  if (debut && !fin) {
    const d = new Date(debut);
    fin = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  }
  if (!debut || !fin)
    return { erreur: "Période indéterminable : choisissez le mois avant de déposer.",
             besoin_periode: true };

  // Les 9 fichiers Synthèse ne portent ni site ni période : contrôle par
  // recoupement avec deux rapports datés déjà en base.
  let recoup = null;
  if (p.synthese === "DIVERS") {
    const [an, rep] = await Promise.all([
      sb(`annulations_lignes?restaurant_id=eq.${restaurant_id}&date_pos=gte.${debut}`
        + `&date_pos=lte.${fin}T23:59:59&select=montant`),
      sb(`repas_employes?restaurant_id=eq.${restaurant_id}&date_heure=gte.${debut}`
        + `&date_heure=lte.${fin}T23:59:59&select=id`)
    ]);
    if (an.length)
      recoup = recouperSynthese(p.brut[0], an.reduce((t, x) => t + Number(x.montant), 0), rep.length);
  }

  const [imp] = await sb("imports", { method: "POST", body: JSON.stringify({
    restaurant_id: Number(restaurant_id),
    type_rapport_code: p.synthese ? "SYNTHESE_CA" : p.type,
    periode_debut: debut, periode_fin: fin,
    fichier_nom: nom_fichier, fichier_hash: hash, nb_lignes: p.nb, nature,
    recoupement_ok: recoup ? recoup.ok : null,
    recoupement_detail: recoup ? recoup.detail : null,
    statut: recoup && !recoup.ok ? "REJETE" : "OK",
    depose_par: ctx.id }) });

  if (recoup && !recoup.ok)
    return { erreur: "Ce fichier ne correspond pas à la période annoncée.", detail: recoup.detail };

  if (p.synthese)
    return { ok: true, import_id: imp.id, type: p.type, synthese: p.synthese, nb: p.nb };

  const lignes = p.donnees.map(d => ({ ...d, import_id: imp.id, restaurant_id: Number(restaurant_id) }));

  // Les flux caissiers (1) et (2) alimentent la même ligne : (1) apporte
  // corrections/annulations/diff. de caisse, (2) les modes de paiement.
  const mois = debut.slice(0, 8) + "01";

  if (p.table === "flux_caissiers" || p.table === "tickets_non_payants") {
    // les rapports cumulés se terminent par une ligne de totaux, sans badge
    const utiles = lignes.filter(l => l.badge_code && String(l.badge_code).trim());
    const cible = `${p.table}?on_conflict=restaurant_id,mois,badge_code`;
    const entete = { prefer: "resolution=merge-duplicates,return=minimal" };
    if (p.fusion) {
      // le rapport (2) complète la ligne créée par le (1) : envoi ligne à
      // ligne pour ne pas écraser les colonnes que lui seul renseigne
      for (const l of utiles)
        await sb(cible, { ...entete, method: "POST", body: JSON.stringify([{ ...l, mois }]) });
    } else {
      for (const l of homogeneiser(utiles.map(x => ({ ...x, mois }))))
        await sb(cible, { ...entete, method: "POST", body: JSON.stringify([l]) });
    }
  } else if (p.table === "flux_responsables") {
    const utiles = lignes.filter(l => l.responsable && String(l.responsable).trim());
    for (const l of homogeneiser(utiles.map(x => ({ ...x, mois }))))
      await sb("flux_responsables?on_conflict=restaurant_id,mois,responsable",
        { method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
          body: JSON.stringify([l]) });
  } else {
    await parLots(p.table, lignes);
  }

  const nouveaux = p.table === "remises_lignes" ? await enregistrerLibelles(p.donnees, debut) : [];
  const anomalies = await genererAnomalies(Number(restaurant_id), debut, fin);

  return { ok: true, import_id: imp.id, type: p.type, nb: p.nb,
           periode: [debut, fin], libelles_a_qualifier: nouveaux, anomalies };
}

/* ---------- libellés de remise appris en marchant ---------- */

async function enregistrerLibelles(donnees, date) {
  // « 2 remises », « 3 remises » sont des regroupements du rapport,
  // pas des libellés paramétrés : ils ne remontent jamais
  const vus = [...new Set(donnees.map(d => d.libelle_remise)
    .filter(l => l && !/^\d+\s+remises?$/i.test(l)))];
  if (!vus.length) return [];
  const connus = await sb(`libelles_remise?select=libelle,statut`);
  const set = new Set(connus.map(c => c.libelle));
  const nouveaux = vus.filter(l => !set.has(l));
  if (nouveaux.length)
    await sb("libelles_remise", { method: "POST", prefer: "return=minimal",
      body: JSON.stringify(nouveaux.map(l => ({
        libelle: l, famille: (l.match(/^\[([^\]]+)\]/) || [, "AUTRE"])[1],
        premiere_vue: date, derniere_vue: date }))) });
  await sb(`libelles_remise?libelle=in.(${vus.map(v => `"${v.replace(/"/g, '')}"`).join(",")})`,
    { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ derniere_vue: date }) });
  return nouveaux;
}

/* ---------- génération des anomalies datées ---------- */

async function genererAnomalies(restaurant_id, debut, fin) {
  const creees = [];
  const pousser = a => creees.push({ restaurant_id, frequence: "HEBDO", statut: "A_VERIFIER", ...a,
    badge_code: normaliserIdentite(a.badge_code),
    manager_code: normaliserIdentite(a.manager_code),
    shift: a.shift || momentShift(a.periode_debut) });

  const [sessions, annuls, remises, cos, libelles] = await Promise.all([
    sb(`sessions_caisse?restaurant_id=eq.${restaurant_id}&date_fiscale=gte.${debut}`
      + `&date_fiscale=lte.${fin}&select=*`),
    sb(`annulations_lignes?restaurant_id=eq.${restaurant_id}&date_pos=gte.${debut}`
      + `&date_pos=lte.${fin}T23:59:59&select=*`),
    sb(`remises_lignes?restaurant_id=eq.${restaurant_id}&date_reelle=gte.${debut}`
      + `&date_reelle=lte.${fin}T23:59:59&select=*`),
    sb(`co_lignes?restaurant_id=eq.${restaurant_id}&date_reelle=gte.${debut}`
      + `&date_reelle=lte.${fin}&select=*&a_risque=is.true`),
    sb(`libelles_remise?select=libelle,statut,neutralise_ratio`)
  ]);
  const statutLibelle = new Map(libelles.map(l => [l.libelle, l.statut]));

  // 1. Écarts de caisse. Les excédents plafonnent naturellement à quelques
  //    euros : un manquant important n'est pas le symétrique du bruit.
  for (const s of sessions) {
    const ecart = Number(s.especes_declare) - Number(s.especes_theorique);
    if (ecart > -SEUIL_ECART_SESSION) continue;
    const tardif = (s.fin_session || "").slice(11, 16) >= "22:00";
    pousser({
      niveau: "SESSION", ratio: "ESPECES",
      periode_debut: s.fin_session || s.date_fiscale, periode_fin: s.fin_session || s.date_fiscale,
      badge_code: s.badge_code, manager_code: s.valide_par, valeur: ecart, montant_ttc: ecart,
      shift: momentShift(s.fin_session),
      score: 30 + (tardif ? 15 : 0),
      regles_declenchees: ["SESSION_ECART_ESPECES", ...(tardif ? ["SESSION_ECART_TARDIF"] : [])],
      echeance_camera: jours(s.date_fiscale, RETENTION_CAMERA),
      pieces: { caisse: s.caisse, theorique: s.especes_theorique, declare: s.especes_declare,
                validee_par: s.valide_par, fin_session: s.fin_session }
    });
  }

  // 2. Annulations hors délai : c'est le délai qui permet de cibler après
  //    coup les gros tickets encaissés en espèces.
  for (const a of annuls) {
    const h = a.delai_heures ?? (a.date_neg && a.date_pos
      ? (new Date(a.date_neg) - new Date(a.date_pos)) / 3600e3 : null);
    if (h === null || h <= DELAI_ANNULATION_H) continue;
    pousser({
      niveau: "TICKET", ratio: "ANNULATIONS",
      periode_debut: a.date_pos, periode_fin: a.date_neg,
      badge_code: a.vendeur_pos, manager_code: a.valide_par_neg || a.manager_neg,
      valeur: h, montant_ttc: a.montant,
      score: Math.min(25 + Math.floor(h / 12) * 5, 45),
      regles_declenchees: ["ANNUL_DELAI"],
      echeance_camera: jours(String(a.date_pos).slice(0, 10), RETENTION_CAMERA),
      pieces: { ticket_positif: a.num_ticket_pos, ticket_negatif: a.num_ticket_neg,
                delai_heures: Math.round(h * 100) / 100, valide_par: a.valide_par_neg }
    });
  }

  // 3. Remises sur libellé non qualifié ou non autorisé. Un libellé créé
  //    localement dans le paramétrage caisse se signale ainsi tout seul.
  const parLibelle = {};
  for (const r of remises) {
    const st = statutLibelle.get(r.libelle_remise) || "A_QUALIFIER";
    if (st === "AUTORISE" || st === "OPERATION") continue;
    (parLibelle[r.libelle_remise] ??= []).push(r);
  }
  for (const [libelle, lignes] of Object.entries(parLibelle)) {
    const st = statutLibelle.get(libelle) || "A_QUALIFIER";
    const dates = lignes.map(l => l.date_reelle).sort();
    const managers = [...new Set(lignes.map(l => l.manager_code))];
    pousser({
      niveau: "TICKET", ratio: "REMISES_50",
      periode_debut: dates[0], periode_fin: dates[dates.length - 1],
      badge_code: [...new Set(lignes.map(l => l.vendeur_code))].length === 1
        ? lignes[0].vendeur_code : null,
      manager_code: managers.length === 1 ? managers[0] : null,
      valeur: lignes.length,
      montant_ttc: lignes.reduce((t, l) => t + Number(l.montant_remise || 0), 0),
      score: st === "NON_AUTORISE" ? 40 : 30,
      regles_declenchees: [st === "NON_AUTORISE" ? "REMISE_LIBELLE_INTERDIT" : "REMISE_LIBELLE_INCONNU"],
      echeance_camera: jours(String(dates[dates.length - 1]).slice(0, 10), RETENTION_CAMERA),
      pieces: { libelle, occurrences: lignes.length, managers,
                tickets: lignes.slice(0, 20).map(l => l.num_ticket),
                heures: [...new Set(lignes.map(l => String(l.date_reelle).slice(11, 13) + "h"))].sort() }
    });
  }

  // 4. Commandes ouvertes : concentration de fin de service et part annulée
  //    par le système, donc sans traçabilité de caisse.
  const parJour = {};
  for (const c of cos) (parJour[c.date_reelle] ??= []).push(c);
  for (const [jour, lignes] of Object.entries(parJour)) {
    const total = lignes.reduce((t, c) => t + Number(c.montant_ttc || 0), 0);
    const tardives = lignes.filter(c => (c.heure || "") >= "21:00");
    const mTard = tardives.reduce((t, c) => t + Number(c.montant_ttc || 0), 0);
    const auto = lignes.filter(c => String(c.annule_par).toUpperCase() === "AUTOMATIQUE");
    const mAuto = auto.reduce((t, c) => t + Number(c.montant_ttc || 0), 0);
    const regles = [];
    if (total > 0 && mTard / total > 0.5 && mTard > 50) regles.push("CO_HORS_RUSH");
    if (total > 0 && mAuto / total > 0.5 && mAuto > 50) regles.push("CO_AUTO_DOMINANT");
    if (!regles.length) continue;
    pousser({
      niveau: "JOUR", ratio: "CO",
      periode_debut: jour, periode_fin: jour,
      valeur: total, montant_ttc: total,
      manager_code: [...new Set(lignes.map(c => c.manager_code).filter(Boolean))].length === 1
        ? lignes[0].manager_code : null,
      score: (regles.includes("CO_HORS_RUSH") ? 15 : 0) + (regles.includes("CO_AUTO_DOMINANT") ? 20 : 0),
      regles_declenchees: regles,
      echeance_camera: jours(jour, RETENTION_CAMERA),
      pieces: { total_jour: total, apres_21h: mTard, automatique: mAuto,
                badges: [...new Set(lignes.map(c => c.annule_par))] }
    });
  }

  if (!creees.length) return { creees: 0 };

  // On ne recrée pas une anomalie déjà ouverte sur la même période.
  const existantes = await sb(`anomalies?restaurant_id=eq.${restaurant_id}`
    + `&periode_debut=gte.${debut}&periode_debut=lte.${fin}T23:59:59&select=niveau,ratio,periode_debut,badge_code`);
  // une date « 2026-08-11 » et la même relue « 2026-08-11T00:00:00+00 »
  // doivent produire la même clé, sinon l'anomalie est recréée à chaque dépôt
  const horodate = v => { const d = new Date(v); return isNaN(d) ? String(v) : d.toISOString().slice(0, 16); };
  const cle = a => `${a.niveau}|${a.ratio}|${horodate(a.periode_debut)}|${a.badge_code || ""}`;
  const deja = new Set(existantes.map(cle));
  const aCreer = creees.filter(a => !deja.has(cle(a)));
  if (aCreer.length)
    await parLots("anomalies", aCreer);
  return { creees: aCreer.length, ignorees: creees.length - aCreer.length };
}

/* ---------- routage ---------- */

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erreur: "POST attendu" });
  try {
    const corps = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const session = lireJeton(corps.jeton);
    if (!session) return res.status(401).json({ erreur: "Session expirée" });
    const [u] = await sb(`utilisateurs?id=eq.${session.uid}&select=id,nom,role,actif`);
    if (!u || !u.actif) return res.status(401).json({ erreur: "Utilisateur inactif" });
    const perim = await rpc("perimetre_utilisateur", { uid: session.uid });
    const ctx = { ...u, depot: perim.filter(p => p.peut_deposer).map(p => p.restaurant_id) };
    return res.status(200).json(await deposer(corps, ctx));
  } catch (e) {
    return res.status(500).json({ erreur: String(e.message || e) });
  }
};
