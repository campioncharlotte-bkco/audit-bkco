/* =====================================================================
   AUDIT BKCO — api/analyse.js
   L'écran que regardent les directeurs. Il ne montre pas des chiffres à
   interpréter : il rend un verdict, et il montre le raisonnement qui y
   mène, ligne par ligne.

   Le verdict n'est jamais un seuil absolu. Un seuil du type « plus de
   10 € par caisse » sanctionnerait un site à forte part d'espèces et
   laisserait passer un vrai problème ailleurs. Trois comparaisons, dont
   la deuxième est la plus solide :

     1. aux collègues du MÊME restaurant, sur le MÊME mois ;
     2. à SON PROPRE historique — la seule référence qui neutralise le
        poste, le site et la saison. Demande 3 mois minimum ;
     3. à la dispersion des faits : mêmes caisses et mêmes équipiers qui
        reviennent, ou faits éparpillés. Éparpillé plaide pour un
        problème de procédure, pas pour une personne.

   Chaque comparaison produit une phrase, à charge ou à décharge, et le
   total décide de la couleur. Un directeur doit pouvoir lire pourquoi.
   ===================================================================== */

const crypto = require("crypto");
const URL_SB = process.env.SUPABASE_URL;
const KEY_SB = process.env.SUPABASE_SERVICE_KEY;
const CLE_IA = process.env.ANTHROPIC_API_KEY;

const MIN_SESSIONS = 10;    // en deçà, aucun classement
const MIN_HISTORIQUE = 3;   // mois nécessaires pour parler de tendance
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
const moyenne = l => l.length ? l.reduce((t, x) => t + Number(x || 0), 0) / l.length : null;
function finDuMois(mois) {
  const an = Number(mois.slice(0, 4)), m = Number(mois.slice(5, 7));
  return `${mois.slice(0, 7)}-${String(new Date(an, m, 0).getDate()).padStart(2, "0")}`;
}

/* ---------- le raisonnement ---------- */

/* Chaque règle rend une phrase et un poids. Poids positif = à charge.
   Aucune règle ne conclut seule : c'est la somme qui donne la couleur,
   et les phrases à décharge comptent autant que les autres. */
function raisonner(e, contexte) {
  const traits = [];
  let points = 0;
  const parSession = Number(e.ecart_par_session) || 0;
  const ajouter = (sens, texte, poids) => {
    traits.push({ sens, texte }); points += (poids || 0);
  };

  // Volume : sans lui, rien n'est comparable.
  if (Number(e.sessions) < MIN_SESSIONS)
    return { feu: "GRIS", points: 0, traits: [{ sens: "neutre",
      texte: `${e.sessions} caisse(s) validée(s) seulement ce mois-ci : c'est trop peu pour `
        + `comparer quoi que ce soit. Aucun classement n'est rendu.` }],
      verdict: `Pas assez de comptages validés pour se prononcer.` };

  // Bruit de comptage : sous 4 € de moyenne, on ne va pas plus loin.
  if (parSession > -PLANCHER_EUR)
    return { feu: "VERT", points: 0, traits: [{ sens: "faveur",
      texte: `${eur(parSession)} de manquant moyen par caisse sur ${e.sessions} comptages : `
        + `c'est le bruit normal d'un comptage manuel.` }],
      verdict: `Rien qui sorte du bruit de comptage habituel.` };

  // 1. Comparaison aux collègues du même mois.
  const med = contexte.mediane_pairs;
  if (med !== null && Math.abs(med) > 0.5) {
    const rapport = Math.abs(parSession) / Math.abs(med);
    if (rapport >= 2) ajouter("charge",
      `${eur(parSession)} de manquant par caisse, contre ${eur(med)} pour la médiane des `
      + `${contexte.nb_pairs} encadrants du restaurant ce mois-ci : plus du double.`, 2);
    else if (rapport >= 1.3) ajouter("charge",
      `${eur(parSession)} par caisse contre ${eur(med)} pour la médiane des `
      + `${contexte.nb_pairs} encadrants du restaurant : au-dessus, sans s'en écarter franchement.`, 1);
    else if (rapport <= 0.8) ajouter("faveur",
      `${eur(parSession)} par caisse, en dessous de la médiane du restaurant (${eur(med)}).`, -1);
    else ajouter("neutre",
      `${eur(parSession)} par caisse, dans la moyenne des encadrants du restaurant (${eur(med)}).`, 0);
  }

  // 2. Comparaison à son propre historique — la référence la plus solide.
  const hist = (e.historique || []).filter(h => h.mois < contexte.mois
    && Number(h.sessions) >= MIN_SESSIONS);
  const base = mediane(hist.slice(-12).map(h => h.ecart_par_session));
  if (hist.length < MIN_HISTORIQUE) {
    ajouter("neutre",
      `Seulement ${hist.length} mois d'historique exploitable : impossible de dire si c'est `
      + `habituel chez cette personne ou si le mois est inhabituel.`, 0);
  } else if (base !== null && Math.abs(base) > 0.5) {
    const r = Math.abs(parSession) / Math.abs(base);
    if (r >= 2) ajouter("charge",
      `Sur ses ${hist.length} mois précédents, cette personne est habituellement à ${eur(base)} `
      + `par caisse. Ce mois-ci elle est à ${eur(parSession)}, soit plus du double de son propre `
      + `niveau. C'est la comparaison la plus parlante : elle ne dépend ni du poste ni du site.`, 3);
    else if (r >= 1.4) ajouter("charge",
      `Habituellement à ${eur(base)} par caisse sur ses ${hist.length} mois précédents, elle est `
      + `à ${eur(parSession)} ce mois-ci : en nette hausse par rapport à elle-même.`, 2);
    else if (r <= 0.7) ajouter("faveur",
      `Habituellement à ${eur(base)} par caisse, elle est à ${eur(parSession)} ce mois-ci : `
      + `en amélioration par rapport à son propre niveau.`, -2);
    else ajouter("neutre",
      `${eur(parSession)} ce mois-ci pour ${eur(base)} habituellement sur ses ${hist.length} mois `
      + `précédents : c'est son niveau ordinaire, pas un décrochage.`, 0);
  }

  // 3. Dispersion des faits : concentré désigne une personne ou un poste,
  //    éparpillé désigne une procédure.
  const f = e.faits || [];
  if (f.length >= 4) {
    const caisses = [...new Set(f.map(x => x.caisse).filter(Boolean))];
    const equipiers = [...new Set(f.map(x => x.equipier).filter(Boolean))];
    if (caisses.length === 1) ajouter("charge",
      `Les ${f.length} comptages en manque viennent tous de la même caisse (${caisses[0]}). `
      + `Une caisse unique oriente vers un poste ou un matériel, à vérifier avant les personnes.`, 1);
    else if (equipiers.length <= 2) ajouter("charge",
      `Les ${f.length} comptages en manque ne concernent que ${equipiers.length} équipier(s) : `
      + `${equipiers.join(", ")}. Cette concentration mérite d'être regardée.`, 2);
    else if (equipiers.length >= 4) ajouter("faveur",
      `Les ${f.length} comptages en manque concernent ${equipiers.length} équipiers différents sur `
      + `${caisses.length} caisses : rien ne se concentre. Cela ressemble davantage à une procédure `
      + `de comptage relâchée sur ces shifts qu'à un problème propre à cette personne.`, -2);
  }

  // 4. Fermetures : le créneau le moins contrôlé.
  const ferm = Math.abs(Number(e.ecart_fermeture) || 0);
  const tot = Math.abs(Number(e.ecart_total) || 0);
  if (tot > 0 && Number(e.sessions_fermeture) >= 5 && ferm / tot >= 0.7) ajouter("charge",
    `${Math.round(ferm / tot * 100)} % du manquant se produit en fermeture, sur `
    + `${e.sessions_fermeture} clôtures : c'est le créneau où les contrôles sont les plus rares.`, 1);

  const feu = points >= 3 ? "ROUGE" : points >= 1 ? "ORANGE" : "VERT";
  const verdict = feu === "ROUGE"
    ? `Plusieurs signaux convergent. À vérifier concrètement, sans présumer de la cause.`
    : feu === "ORANGE"
      ? `Un signal ressort, les autres non. À surveiller le mois prochain.`
      : `Rien qui sorte de l'ordinaire, ni par rapport aux collègues ni par rapport à ses propres mois.`;
  return { feu, points, traits, verdict };
}

const ORDRE_FEU = { ROUGE: 0, ORANGE: 1, VERT: 2, GRIS: 3 };

/* ---------- synthèse ---------- */

async function synthese({ restaurant_id, mois }, ctx) {
  if (!ctx.lecture.includes(Number(restaurant_id))) return { erreur: "Hors périmètre" };
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

  const [sessions, parCaisse] = await Promise.all([
    sb(`v_ecarts_sessions?restaurant_id=eq.${rid}&date_fiscale=gte.${m.slice(0,7)}-01`
      + `&date_fiscale=lte.${finDuMois(m)}&select=*&order=ecart_especes.asc`),
    sb(`v_caisses_ecarts?restaurant_id=eq.${rid}&mois=eq.${m}&select=*`)
  ]);

  const duMois = suivi.filter(l => l.mois === m && !ctx.masques.includes(l.responsable));
  const eligibles = duMois.filter(l => Number(l.sessions) >= MIN_SESSIONS);
  const contexte = {
    mois: m,
    mediane_pairs: mediane(eligibles.map(l => l.ecart_par_session)),
    part_deficit_moyenne: moyenne(eligibles.map(l => l.part_deficit)),
    nb_pairs: eligibles.length
  };

  const nonCompensees = sessions.filter(s => !s.compense
    && !ctx.masques.includes(s.badge_code) && !ctx.masques.includes(s.responsable));
  const compensees = sessions.filter(s => s.compense);

  const encadrants = duMois.map(l => {
    const faits = nonCompensees.filter(s => s.responsable === l.responsable).map(s => ({
      date: s.date_fiscale, caisse: s.caisse, shift: s.shift,
      equipier: noms[s.badge_code] || s.badge_code,
      ecart: s.ecart_especes, echeance_camera: s.echeance_camera,
      nb_remise: s.nb_remise, nb_annulation: s.nb_annulation }));
    const historique = suivi.filter(h => h.responsable === l.responsable)
      .sort((a, b) => a.mois < b.mois ? -1 : 1)
      .map(h => ({ mois: h.mois, sessions: h.sessions, part_deficit: h.part_deficit,
                   ecart_par_session: h.ecart_par_session, ecart_total: h.ecart_total }));
    const base = { code: l.responsable, nom: l.nom_affiche || noms[l.responsable] || l.responsable,
      sessions: l.sessions, sessions_deficit: l.sessions_deficit, part_deficit: l.part_deficit,
      ecart_total: l.ecart_total, ecart_par_session: l.ecart_par_session,
      sessions_fermeture: l.sessions_fermeture, ecart_fermeture: l.ecart_fermeture,
      mediane_pairs: contexte.mediane_pairs, part_deficit_moyenne: contexte.part_deficit_moyenne,
      historique, faits };
    const r = raisonner(base, contexte);
    // repère de lecture immédiat : le mois précédent du même encadrant
    const precedent = historique.filter(h => h.mois < m).slice(-1)[0] || null;
    return { ...base, feu: r.feu, verdict: r.verdict, traits: r.traits, points: r.points,
             precedent, faits: faits.slice(0, 15), nb_faits: faits.length };
  }).sort((a, b) => ORDRE_FEU[a.feu] - ORDRE_FEU[b.feu]
                 || (Number(a.ecart_par_session) || 0) - (Number(b.ecart_par_session) || 0));

  const caissePire = parCaisse.slice().sort((a, b) =>
    (Number(b.taux_lourdes) || 0) - (Number(a.taux_lourdes) || 0))[0] || null;

  return {
    mois: m, mois_disponibles: moisDispo, restaurant: resto[0] || null, noms,
    resume: {
      sessions: parCaisse.reduce((t, c) => t + Number(c.sessions || 0), 0),
      manquants: nonCompensees.length,
      montant_manquants: nonCompensees.reduce((t, s) => t + Number(s.ecart_especes || 0), 0),
      compensees: compensees.length,
      mediane_pairs: contexte.mediane_pairs,
      part_deficit_moyenne: contexte.part_deficit_moyenne,
      caisse_a_regarder: caissePire && Number(caissePire.taux_lourdes) >= 10 ? caissePire : null
    },
    encadrants
  };
}

/* ---------- explication rédigée ---------- */

const CONSIGNE = `Tu écris pour un directeur de restaurant Burger King qui n'est ni
comptable ni analyste. Tu reçois le dossier chiffré d'un encadrant sur un mois, y
compris le raisonnement déjà établi par l'application (champ "traits", avec le sens
"charge", "faveur" ou "neutre").

Écris 4 à 6 phrases en français simple, sans titre, sans liste à puces, sans jargon.
Reprends le raisonnement fourni, ne le contredis pas et n'invente aucun chiffre.

Règles absolues :
- Ne jamais affirmer ni suggérer un vol, une fraude ou une malhonnêteté. Tu décris
  un écart à expliquer, rien d'autre.
- Toujours rappeler l'explication banale quand elle existe : erreur de rendu monnaie,
  encaissement saisi dans le mauvais mode de règlement, fonds de caisse, procédure de
  comptage, poste très exposé aux espèces.
- Reprendre explicitement les éléments à décharge présents dans "traits". Ils comptent
  autant que les autres et le directeur doit les lire.
- Si l'historique compte moins de trois mois exploitables, dire que la comparaison est
  fragile et qu'un mois isolé ne prouve rien.
- Terminer par une action concrète et proportionnée : recompter avec la personne, revoir
  la procédure de fermeture, regarder les images d'une date précise si elle est encore
  dans les 14 jours.
- Pas de recommandation disciplinaire, pas de conclusion définitive.`;

function explicationDeSecours(d) {
  const p = [`Sur ${moisLisible(d.mois)}, ${d.nom} a validé ${d.sessions} comptages de caisse, `
    + `dont ${d.sessions_deficit} présentent un manquant, soit ${eur(d.ecart_par_session)} par caisse.`];
  (d.traits || []).forEach(t => p.push(t.texte));
  p.push(`Avant toute autre hypothèse, les explications ordinaires doivent être écartées : `
    + `erreur de rendu monnaie, encaissement saisi en carte au lieu d'espèces, fonds de caisse `
    + `mal repris, ou simplement un poste très exposé aux espèces.`);
  const recente = (d.faits || []).find(f => f.echeance_camera
    && new Date(f.echeance_camera) >= new Date());
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
        model: "claude-sonnet-4-6", max_tokens: 800, system: CONSIGNE,
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
