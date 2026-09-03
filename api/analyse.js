/* =====================================================================
   AUDIT BKCO — api/analyse.js
   L'écran que regardent les directeurs. Il ne montre pas des chiffres à
   interpréter : il rend un verdict par encadrant, avec les faits qui le
   fondent et une explication en français.

   Deux principes, tirés du test Abbeville de septembre 2026 :
     * on ne compare jamais un encadrant à un seuil absolu, mais à la
       médiane des encadrants du MÊME restaurant sur le MÊME mois — sans
       quoi le plus exposé ressort toujours en rouge ;
     * en dessous de 10 caisses validées, on ne classe pas. Six lignes
       sans dénominateur nous ont déjà fait conclure n'importe quoi.
   ===================================================================== */

const crypto = require("crypto");
const URL_SB = process.env.SUPABASE_URL;
const KEY_SB = process.env.SUPABASE_SERVICE_KEY;
const CLE_IA = process.env.ANTHROPIC_API_KEY;

const MIN_SESSIONS = 10;    // en deçà, aucun classement
const PLANCHER_EUR = 4;     // un écart moyen sous 4 € reste du bruit de comptage

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

const sign = d => crypto.createHmac("sha256", KEY_SB).update(d).digest("base64url");
function lireJeton(j) {
  if (!j || !j.includes(".")) return null;
  const [p, s] = j.split(".");
  if (sign(p) !== s) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString());
        return d.exp > Date.now() ? d : null; } catch { return null; }
}

const MOIS_FR = ["janvier","février","mars","avril","mai","juin",
                 "juillet","août","septembre","octobre","novembre","décembre"];
const moisLisible = m => m ? `${MOIS_FR[Number(m.slice(5,7)) - 1]} ${m.slice(0,4)}` : "";
const eur = n => (n === null || n === undefined ? "—"
  : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €");
function mediane(liste) {
  const v = liste.filter(x => x !== null && x !== undefined).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function finDuMois(mois) {
  const an = Number(mois.slice(0, 4)), m = Number(mois.slice(5, 7));
  return `${mois.slice(0, 7)}-${String(new Date(an, m, 0).getDate()).padStart(2, "0")}`;
}

/* ---------- le verdict ---------- */

/* Rouge et orange ne disent pas « cette personne vole ». Ils disent : les
   caisses que cette personne valide manquent nettement plus que celles de
   ses collègues, sur le même site et le même mois. C'est un point de
   départ pour aller voir, pas une conclusion. */
function classer(e, medianeResto) {
  const parSession = Number(e.ecart_par_session) || 0;
  if (Number(e.sessions) < MIN_SESSIONS)
    return { feu: "GRIS", verdict: `Seulement ${e.sessions} caisse(s) validée(s) : trop peu `
      + `pour comparer quoi que ce soit.` };
  if (parSession > -PLANCHER_EUR)
    return { feu: "VERT", verdict: `Écart moyen de ${eur(parSession)} par caisse : `
      + `c'est du bruit de comptage normal.` };
  const ref = medianeResto === null || medianeResto === 0 ? null : Math.abs(medianeResto);
  const rapport = ref ? Math.abs(parSession) / ref : null;
  if (rapport === null)
    return { feu: "VERT", verdict: `Écart moyen de ${eur(parSession)} par caisse.` };
  if (rapport >= 2)
    return { feu: "ROUGE", verdict: `${eur(parSession)} de manquant par caisse, contre `
      + `${eur(medianeResto)} pour la médiane du restaurant : plus du double. À vérifier.` };
  if (rapport >= 1.3)
    return { feu: "ORANGE", verdict: `${eur(parSession)} par caisse, au-dessus de la médiane `
      + `du restaurant (${eur(medianeResto)}) sans s'en écarter franchement. À surveiller.` };
  return { feu: "VERT", verdict: `${eur(parSession)} par caisse, dans la normale du `
    + `restaurant (${eur(medianeResto)}).` };
}

const ORDRE_FEU = { ROUGE: 0, ORANGE: 1, VERT: 2, GRIS: 3 };

/* ---------- synthèse ---------- */

async function synthese({ restaurant_id, mois }, ctx) {
  if (!ctx.lecture.includes(Number(restaurant_id)))
    return { erreur: "Hors périmètre" };
  const rid = Number(restaurant_id);

  const [suivi, ids, resto] = await Promise.all([
    sb(`v_encadrants_mois?restaurant_id=eq.${rid}&select=*&order=mois.desc`),
    sb(`v_identites?restaurant_id=eq.${rid}&select=*`),
    sb(`restaurants?id=eq.${rid}&select=id,nom`)
  ]);
  const moisDispo = [...new Set(suivi.map(l => l.mois))].sort().reverse();
  const m = mois || moisDispo[0] || null;
  if (!m) return { mois: null, mois_disponibles: [], encadrants: [],
                   restaurant: resto[0] || null, resume: null };

  const noms = {};
  ids.forEach(i => noms[i.badge_code] = i.nom_affiche);

  const [sessions, anomalies, parCaisse] = await Promise.all([
    sb(`v_ecarts_sessions?restaurant_id=eq.${rid}&date_fiscale=gte.${m.slice(0,7)}-01`
      + `&date_fiscale=lte.${finDuMois(m)}&select=*&order=ecart_especes.asc`),
    sb(`anomalies?restaurant_id=eq.${rid}&statut=eq.A_VERIFIER&select=*`
      + `&order=echeance_camera.asc.nullslast&limit=400`),
    sb(`v_caisses_ecarts?restaurant_id=eq.${rid}&mois=eq.${m}&select=*`)
  ]);

  const duMois = suivi.filter(l => l.mois === m && !ctx.masques.includes(l.responsable));
  const med = mediane(duMois.filter(l => Number(l.sessions) >= MIN_SESSIONS)
                            .map(l => l.ecart_par_session));

  const nonCompensees = sessions.filter(s => !s.compense
    && !ctx.masques.includes(s.badge_code) && !ctx.masques.includes(s.responsable));
  const compensees = sessions.filter(s => s.compense);

  const encadrants = duMois.map(l => {
    const c = classer(l, med);
    const sesSessions = nonCompensees.filter(s => s.responsable === l.responsable);
    const sesAnomalies = anomalies.filter(a => a.manager_code === l.responsable);
    return {
      code: l.responsable,
      nom: l.nom_affiche || noms[l.responsable] || l.responsable,
      feu: c.feu, verdict: c.verdict,
      sessions: l.sessions, sessions_deficit: l.sessions_deficit,
      part_deficit: l.part_deficit,
      ecart_total: l.ecart_total, ecart_par_session: l.ecart_par_session,
      sessions_fermeture: l.sessions_fermeture, ecart_fermeture: l.ecart_fermeture,
      mediane_restaurant: med,
      historique: suivi.filter(h => h.responsable === l.responsable)
        .sort((a, b) => a.mois < b.mois ? -1 : 1)
        .map(h => ({ mois: h.mois, sessions: h.sessions, part_deficit: h.part_deficit,
                     ecart_par_session: h.ecart_par_session, ecart_total: h.ecart_total })),
      faits: sesSessions.slice(0, 12).map(s => ({
        date: s.date_fiscale, caisse: s.caisse, shift: s.shift,
        equipier: noms[s.badge_code] || s.badge_code,
        ecart: s.ecart_especes, echeance_camera: s.echeance_camera,
        nb_remise: s.nb_remise, nb_annulation: s.nb_annulation })),
      anomalies: sesAnomalies.slice(0, 20).map(a => ({
        id: a.id, date: a.periode_debut, montant: a.montant_ttc, shift: a.shift,
        regle: (a.regles_declenchees || [])[0], echeance_camera: a.echeance_camera }))
    };
  }).sort((a, b) => ORDRE_FEU[a.feu] - ORDRE_FEU[b.feu]
                 || (Number(a.ecart_par_session) || 0) - (Number(b.ecart_par_session) || 0));

  const caissePire = parCaisse.slice().sort((a, b) =>
    (Number(b.taux_lourdes) || 0) - (Number(a.taux_lourdes) || 0))[0] || null;

  return {
    mois: m, mois_disponibles: moisDispo, restaurant: resto[0] || null, noms,
    resume: {
      sessions: parCaisse.reduce((t, c) => t + Number(c.sessions || 0), 0),
      ecart_total: parCaisse.reduce((t, c) => t + Number(c.ecart_cumule || 0), 0),
      manquants: nonCompensees.length,
      montant_manquants: nonCompensees.reduce((t, s) => t + Number(s.ecart_especes || 0), 0),
      compensees: compensees.length,
      montant_compensees: compensees.reduce((t, s) => t + Number(s.ecart_especes || 0), 0),
      caisses: parCaisse.sort((a, b) => (Number(b.taux_lourdes)||0) - (Number(a.taux_lourdes)||0)),
      caisse_a_regarder: caissePire && Number(caissePire.taux_lourdes) >= 10 ? caissePire : null
    },
    encadrants
  };
}

/* ---------- explication rédigée ---------- */

const CONSIGNE = `Tu écris pour un directeur de restaurant Burger King qui n'est ni
comptable ni analyste. Tu reçois le dossier chiffré d'un encadrant sur un mois.

Écris 4 à 6 phrases en français simple, sans titre, sans liste à puces, sans jargon.
Structure implicite : ce que disent les chiffres, ce qui pourrait l'expliquer
banalement, ce qu'il faut aller vérifier concrètement.

Règles absolues :
- Ne jamais affirmer ni suggérer un vol, une fraude ou une malhonnêteté. Tu décris
  un écart à expliquer, rien d'autre.
- Toujours rappeler l'explication banale quand elle existe : erreur de rendu monnaie,
  encaissement saisi dans le mauvais mode de règlement, fonds de caisse, procédure de
  comptage, poste très exposé aux espèces.
- Un seul mois ne prouve rien. Si l'historique fourni compte moins de trois mois, dis-le.
- Si le nombre de caisses validées est faible, dis que la comparaison est fragile.
- Termine par une action concrète et proportionnée : recompter avec la personne,
  revoir la procédure de fermeture, regarder les images d'une date précise si elle est
  encore dans les 14 jours.
- Pas de recommandation disciplinaire, pas de conclusion définitive.`;

function explicationDeSecours(d) {
  const p = [];
  p.push(`Sur ${moisLisible(d.mois)}, ${d.nom} a validé ${d.sessions} comptages de caisse, `
    + `dont ${d.sessions_deficit} présentent un manquant, pour ${eur(d.ecart_total)} au total, `
    + `soit ${eur(d.ecart_par_session)} par caisse.`);
  if (d.mediane_restaurant !== null)
    p.push(`La médiane du restaurant sur le même mois est de ${eur(d.mediane_restaurant)} par caisse.`);
  if ((d.historique || []).length < 3)
    p.push(`On ne dispose que de ${(d.historique || []).length} mois d'historique : c'est trop peu `
      + `pour parler de tendance, un mois isolé peut n'être qu'un mauvais mois.`);
  p.push(`Avant toute autre hypothèse, les explications ordinaires doivent être écartées : `
    + `erreur de rendu monnaie, encaissement saisi en carte au lieu d'espèces, fonds de caisse `
    + `mal repris, ou simplement un poste très exposé aux espèces.`);
  const recente = (d.faits || []).find(f => f.echeance_camera
    && new Date(f.echeance_camera) > new Date());
  p.push(recente
    ? `Concrètement : recomptez une caisse avec la personne, et regardez les images du `
      + `${new Date(recente.date).toLocaleDateString("fr-FR")} tant qu'elles sont disponibles.`
    : `Concrètement : recomptez une caisse avec la personne et revoyez ensemble la procédure `
      + `de fermeture. Les images de ces dates ne sont plus disponibles.`);
  return p.join(" ");
}

async function expliquer({ restaurant_id, code, mois }, ctx) {
  const d = await synthese({ restaurant_id, mois }, ctx);
  if (d.erreur) return d;
  const e = (d.encadrants || []).find(x => x.code === code);
  if (!e) return { erreur: "Encadrant introuvable sur ce mois." };

  const dossier = { ...e, mois: d.mois, restaurant: d.restaurant && d.restaurant.nom,
                    contexte_restaurant: d.resume };
  if (!CLE_IA) return { texte: explicationDeSecours(dossier), source: "regles" };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CLE_IA, "anthropic-version": "2023-06-01",
                 "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 700, system: CONSIGNE,
        messages: [{ role: "user", content: JSON.stringify(dossier) }] })
    });
    const j = await r.json();
    const texte = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    if (!texte) throw new Error("réponse vide");
    return { texte, source: "ia" };
  } catch {
    return { texte: explicationDeSecours(dossier), source: "regles" };
  }
}

/* ---------- routage ---------- */

const actions = { synthese, expliquer };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erreur: "POST attendu" });
  try {
    const corps = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { action, jeton, ...params } = corps;
    if (!actions[action]) return res.status(400).json({ erreur: "Action inconnue" });
    const session = lireJeton(jeton);
    if (!session) return res.status(401).json({ erreur: "Session expirée" });
    const [u] = await sb(`utilisateurs?id=eq.${session.uid}&select=id,nom,role,actif`);
    if (!u || !u.actif) return res.status(401).json({ erreur: "Utilisateur inactif" });
    const perim = await rpc("perimetre_utilisateur", { uid: session.uid });
    const masques = (await rpc("badges_masques", { uid: session.uid })).map(b => b.badge_code);
    const ctx = { ...u, masques,
      lecture: perim.filter(p => p.peut_lire).map(p => p.restaurant_id),
      cloture: perim.filter(p => p.peut_cloturer).map(p => p.restaurant_id) };
    return res.status(200).json(await actions[action](params, ctx));
  } catch (e) {
    return res.status(500).json({ erreur: String(e.message || e) });
  }
};
