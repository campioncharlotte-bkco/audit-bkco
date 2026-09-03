/* =====================================================================
   AUDIT BKCO — parsers des exports Cash Système
   Un seul module, utilisé côté navigateur au dépôt et côté serveur.
   Principe : chaque type de rapport déclare le mapping colonne CSV ->
   colonne de table. Le type est détecté sur les en-têtes, pas sur le nom
   du fichier (les 9 fichiers Synthèse n'ont ni site ni période).
   ===================================================================== */

const S = ";";

/* ---------- utilitaires ---------- */

function parseCSV(texte) {
  const t = texte.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const lignes = [];
  let champ = "", ligne = [], guill = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (guill) {
      if (c === '"' && t[i + 1] === '"') { champ += '"'; i++; }
      else if (c === '"') guill = false;
      else champ += c;
    } else if (c === '"') guill = true;
    else if (c === S) { ligne.push(champ); champ = ""; }
    else if (c === "\n") { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ""; }
    else champ += c;
  }
  if (champ !== "" || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const entetes = lignes.shift().map(h => h.trim());
  return lignes.filter(l => l.some(v => v !== "")).map(l => {
    const o = {};
    entetes.forEach((h, i) => o[h] = (l[i] ?? "").trim());
    return o;
  });
}

// Cash Système écrit les décimales à la virgule et les milliers à l'espace.
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).replace(/\u00a0|\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function pct(v) { const n = num(v); return n === null ? null : n * 100; }  // synthèse : ratios en base 1
function date(v) { return v ? String(v).slice(0, 10) : null; }
function horo(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s.length <= 10 ? s : s.slice(0, 10) + "T" + s.slice(11, 19);
}
function heure(v) { return v ? String(v).slice(0, 5) : null; }

/* ---------- mappings ---------- */

const M = {
  DECLARATION_CAISSE: {
    table: "sessions_caisse",
    cle: ["CODEVENDEUR", "ESPECESTHEORIQUE", "FONDDECAISSE"],
    map: r => ({
      badge_code: r.LIBELLEVENDEUR, valide_par: r.VALIDATIONRESPONSABLE, caisse: r.CAISSE,
      date_fiscale: date(r.DATEFISCALE),
      fin_session: horo(r.DATE_REELLE_FIN_SESSION + " " + r.HEURE_FIN_SESSION + ":00"),
      validation_session: horo(r.DATE_REELLE_VALIDATION_SESSION + " " + r.HEURE_VALIDATION_SESSION + ":00"),
      fond_de_caisse: num(r.FONDDECAISSE),
      especes_theorique: num(r.ESPECESTHEORIQUE), especes_declare: num(r.ESPCESDECLARE),
      prelevement: num(r.PRELEVEMENT),
      cb_theorique: num(r.CBTHEORIQUE), cb_declare: num(r.CBDECLARE),
      tpe_theorique: num(r.TPEMOBILETHEORIQUE), tpe_declare: num(r.TPEMOBILEDECLARE),
      nb_correction: num(r.NBCORRECTION), montant_correction: num(r.MONTANTCORRECTION),
      nb_annulation: num(r.NBANNULATION), montant_annulation: num(r.MONTANTANNULATION),
      nb_remise: num(r.NBREMISE), montant_remise: num(r.MONTANTREMISE)
    })
  },

  COMMANDES_OUVERTES: {
    table: "co_lignes",
    cle: ["RESTAURANTID", "PROFIT", "ANNULE_PAR"],
    map: r => ({
      date_reelle: date(r.DATEREELLE), heure: heure(r.HEURE),
      profit: r.PROFIT, localisation: r.LOCALISATION, caisse: r.CAISSE,
      manager_code: r.MANAGER, vendeur_code: r.VENDEUR, montant_ttc: num(r.MONTANTTTC),
      rappele_par: r.RAPPELE_PAR || null, rappele_le: horo(r.HORODATAGERAPPEL),
      annule_par: r.ANNULE_PAR || null, annule_le: horo(r.HORODATAGECANCEL),
      correction_avant: num(r.MONTANTCORRECTIONAVANTTOTAL),
      correction_apres: num(r.MONTANTCORRECTIONAPRESTOTAL),
      delai_annulation: num(r.DELAIANNULATION), num_orb: r.NUMORB
    })
  },

  CORRECTIONS: {
    table: "corrections_lignes",
    cle: ["MONTANT_TTC_TICKET_AVANT_CORRECTION", "MONTANTCORRECTION"],
    map: r => ({
      date_reelle: horo(r.DATEREELLE), date_fiscale: date(r.DATEFISCALE),
      vendeur_code: r.LIBELLEVENDEUR, caisse: r.CAISSE, localisation: r.LOCALISATION,
      montant_avant: num(r.MONTANT_TTC_TICKET_AVANT_CORRECTION),
      montant: num(r.MONTANTCORRECTION), nb_corrections: num(r.NOMBRE_CORRECTION),
      num_ticket: r.NUM_TICKET, id_unique_ticket: r.ID_UNIQUE_TICKET
    })
  },

  REMISES: {
    table: "remises_lignes",
    cle: ["LIBELLE_REMISE", "MONTANT_AVANT_REMISE"],
    map: r => ({
      date_reelle: horo(r.DATEREELLE),
      vendeur_code: r.LIBELLEVENDEUR, manager_code: r.LIBELLEMANAGER,
      caisse: r.CAISSE, localisation: r.LOCALISATION,
      libelle_remise: r.LIBELLE_REMISE,
      montant_remise: num(r.MONTANT_REMISE), montant_avant: num(r.MONTANT_AVANT_REMISE),
      num_ticket: r.NUM_TICKET, id_unique_ticket: r.ID_UNIQUE_TICKET,
      commentaire: r.COMMENTAIRE || null
    })
  },

  ANNULATIONS: {
    table: "annulations_lignes",
    cle: ["CODEVENDEUR_TICKETPOSITIF", "MONTANTAVANTANNULATION"],
    map: r => ({
      montant: num(r.MONTANTAVANTANNULATION),
      vendeur_pos: r.LIBELLEVENDEUR_TICKETPOSITIF, manager_pos: r.LIBELLEMANAGER_TICKETPOSITIF,
      valide_par_pos: r.VALIDATIONRESPONSABLE_TICKETPOSITIF,
      num_ticket_pos: r.NUM_TICKET_POSITIF || r.NUMTICKETPOSITIF,
      date_pos: horo(r.DATEREELLE_TICKETPOSITIF),
      vendeur_neg: r.LIBELLEVENDEUR_TICKETNEGATIF, manager_neg: r.LIBELLEMANAGER_TICKETNEGATIF,
      valide_par_neg: r.VALIDATIONRESPONSABLE_TICKETNEGATIF,
      num_ticket_neg: r.NUM_TICKET_NEGATIF || r.NUMTICKETNEGATIF,
      date_neg: horo(r.DATEREELLE_TICKETNEGATIF),
      caisse: r.CAISSE_TICKETPOSITIF
    })
  },

  FLUX_CAISSIERS_1: {
    table: "flux_caissiers",
    cle: ["CA_THEORIQUE_BRUT", "DIFF_DE_CAISSE"],
    map: r => ({
      badge_code: r.CAISSIER, nb_caisses: num(r.NB_CAISSE),
      ca_theorique_brut: num(r.CA_THEORIQUE_BRUT), ca_theorique_net: num(r.CA_THEORIQUE_NET),
      ca_declare: num(r.CA_DECLARE), remise: num(r.REMISE),
      nb_annulation: num(r.NB_ANNULATION), annulation: num(r.ANNULATION),
      nb_correction: num(r.NB_CORRECTION), correction: num(r.CORRECTION),
      non_rendu: num(r.NON_RENDU), diff_caisse: num(r.DIFF_DE_CAISSE)
    })
  },

  FLUX_CAISSIERS_2: {
    table: "flux_caissiers",
    cle: ["MONTANT_DELIVERY_DECLARE", "MONTANT_TRD_DECLARE"],
    fusion: true,   // complète la ligne créée par le rapport (1)
    map: r => ({
      badge_code: r.CAISSIER, ca_declare: num(r.CA_REEL),
      cb_declare: num(r.CB_DECLARE),
      especes_declare: num(r.ESPECES_DECLARE), especes_ecart: num(r.ESPECES_ECART),
      tr_declare: num(r.TICKET_REST_DECLARE), trd_declare: num(r.MONTANT_TRD_DECLARE),
      delivery_declare: num(r.MONTANT_DELIVERY_DECLARE)
    })
  },

  TICKETS_NON_PAYANTS: {
    table: "tickets_non_payants",
    cle: ["NB_TICKET_A_0_EURO", "TAUX_DISCOUNT"],
    map: r => ({
      badge_code: r.LIBELLEVENDEUR,
      nb_ticket_0: num(r.NB_TICKET_A_0_EURO), nb_ticket_0_099: num(r.NB_TICKET_0_A_0_EURO_99),
      nb_ticket_1_150: num(r.NB_TICKET_1_A_1_EURO_50),
      ticket_moyen: num(r.TICKET_MOYEN), nombre_ticket: num(r.NOMBRE_TICKET),
      taux_discount: num(r.TAUX_DISCOUNT), taux_especes: num(r.TAUX_ESPECES),
      taux_correction: num(r.TAUX_CORRECTION), nb_ticket_remise: num(r.NOMBRE_DE_TICKET_REMISE)
    })
  },

  CA_JOURNALIER: {
    table: "ca_journalier",
    cle: ["CA_BRUT_TTC", "CA_NET_HT", "TAC"],
    map: r => ({
      date_fiscale: date(r.DATE),
      ca_brut_ttc: num(r.CA_BRUT_TTC), ca_net_ht: num(r.CA_NET_HT),
      ca_comptoir_ttc: (num(r.CA_BRUT_TTC_COMPTOIR_PLACE) || 0) + (num(r.CA_BRUT_TTC_COMPTOIR_EMPORTER) || 0),
      ca_kiosk_ttc: num(r.CA_BRUT_TTC_KIOSK), ca_drive_ttc: num(r.CA_BRUT_TTC_DRIVE),
      ca_delivery_ttc: num(r.CA_BRUT_TTC_DELIVERY),
      correction: num(r.CORRECTION), taux_correction: num(r.TAUX_CORRECTION),
      annulation: num(r.ANNULATION), taux_annulation: num(r.TAUX_ANNULATION),
      remise: num(r.REMISE), taux_remise: num(r.TAUX_REMISE), tac: num(r.TAC)
    })
  },

  ACTION_PAR_JOUR: {
    table: "actions_jour",
    cle: ["ACTION", "NOM_MANAGER", "HORODATAGE"],
    map: r => ({
      action: r.ACTION, date_fiscale: date(r.DATE), horodatage: heure(r.HORODATAGE),
      manager_code: r.NOM_MANAGER, vendeur_code: r.NOM_VENDEUR,
      caisse: r.CAISSE, localisation: r.LOCALISATION
    })
  },

  REPAS_EMPLOYE: {
    table: "repas_employes",
    cle: ["CODE_BENEFICIAIRE", "COURONNES"],
    map: r => ({
      beneficiaire: r.BENEFICIAIRE, montant: num(r.MONTANT), couronnes: num(r.COURONNES),
      date_heure: horo(r.DATE_ET_HEURE), vendeur_code: r.LIB_VENDEUR,
      manager_code: r.MANAGER, caisse: r.IP_CAISSE
    })
  },

  FLUX_RESP_1: {
    table: "flux_responsables",
    cle: ["RESPONSABLES_CAISSE", "ANNULATION_VALIDATION_COMPTOIR"],
    map: r => ({
      responsable: r.RESPONSABLES_CAISSE, nb_caisses: num(r.NB_CAISSE),
      ca_declare: num(r.CA_DECLARE), remise: num(r.REMISE),
      nb_annulation: num(r.NB_ANNULATION), annulation: num(r.ANNULATION),
      nb_annulation_comptoir: num(r.NB_ANNULATION_VALIDATION_COMPTOIR),
      annulation_comptoir: num(r.ANNULATION_VALIDATION_COMPTOIR),
      nb_correction: num(r.NB_CORRECTION), correction: num(r.CORRECTION),
      non_rendu: num(r.NON_RENDU)
    })
  },

  /* --- Synthèse CA par canal : 9 fichiers sans site ni période --- */
  SYNTHESE_CA_PROFIT:   { synthese: "CA_PAR_PROFIT",   cle: ["profit", "panierMoyenTTC"] },
  SYNTHESE_CORRECTIONS: { synthese: "CORRECTIONS",     cle: ["montant_correction_avant_total"] },
  SYNTHESE_REMISES:     { synthese: "REMISES",         cle: ["montant_remise_sup50", "localisation"] },
  SYNTHESE_REGLEMENT:   { synthese: "REGLEMENT",       cle: ["theorique", "compte", "preleve"] },
  SYNTHESE_DIVERS:      { synthese: "DIVERS",          cle: ["nombreRepasEmployes", "montantPertes"] },
  SYNTHESE_OPERATION:   { synthese: "OPERATION",       cle: ["tauxCorrection", "nombreCorrection"] },
  SYNTHESE_TVA:         { synthese: "TVA",             cle: ["TTC", "TVA", "libelle"] },
  SYNTHESE_CONSO:       { synthese: "CONSO_PAR_PROFIT",cle: ["SP_tac", "AE_caht"] },
  SYNTHESE_ANNEXES:     { synthese: "VENTES_ANNEXES",  cle: ["montantHT", "nbr", "libelle"] }
};

/* ---------- détection du type sur les en-têtes ---------- */

function detecterType(entetes) {
  const set = new Set(entetes);
  let meilleur = null, score = 0;
  for (const [code, def] of Object.entries(M)) {
    const n = def.cle.filter(c => set.has(c)).length;
    if (n === def.cle.length && n > score) { meilleur = code; score = n; }
  }
  return meilleur;
}

/* ---------- point d'entrée ---------- */

function parser(texte, nomFichier) {
  const lignes = parseCSV(texte);
  if (!lignes.length) return { erreur: "Fichier vide" };
  const entetes = Object.keys(lignes[0]);
  const type = detecterType(entetes);
  if (!type) return { erreur: "Type de rapport non reconnu", entetes };
  const def = M[type];

  if (def.synthese) return { type, synthese: def.synthese, brut: lignes, nb: lignes.length };

  const donnees = lignes.map(def.map).filter(o => Object.values(o).some(v => v !== null && v !== ""));
  const res = { type, table: def.table, fusion: !!def.fusion, donnees, nb: donnees.length };

  // période lue dans les données, jamais dans le nom du fichier
  const champsDate = ["date_fiscale", "date_reelle", "date_pos", "date_heure"];
  const dates = donnees.flatMap(d => champsDate.map(c => d[c]).filter(Boolean)).map(d => String(d).slice(0, 10)).sort();
  if (dates.length) { res.periode_debut = dates[0]; res.periode_fin = dates[dates.length - 1]; }

  // restaurant, quand le rapport le porte
  const l0 = lignes[0];
  if (l0.RESTAURANTID) res.code_cash = l0.RESTAURANTID;
  if (l0.LIBSITE) res.libelle_site = l0.LIBSITE;
  if (l0.RESTAURANT_ID) res.code_cash = l0.RESTAURANT_ID;

  return res;
}

/* ---------- contrôles d'intégrité ---------- */

// Les 9 fichiers Synthèse ne portent ni site ni période : on vérifie leur
// mois par recoupement avec deux rapports datés. Validé sur 3 mois.
function recouperSynthese(divers, totalAnnulations, nbRepasEmployes) {
  const pertes = num(divers.montantPertes), repas = num(divers.nombreRepasEmployes);
  const okPertes = Math.abs(pertes - totalAnnulations) < 0.01;
  const okRepas = repas === nbRepasEmployes;
  return {
    ok: okPertes && okRepas,
    detail: `pertes ${pertes} vs annulations ${totalAnnulations} ${okPertes ? "OK" : "ECHEC"} | `
          + `repas ${repas} vs ${nbRepasEmployes} ${okRepas ? "OK" : "ECHEC"}`
  };
}

// Jours sans aucune ligne sur la période couverte : dépôt partiel.
function joursManquants(donnees, champ, debut, fin) {
  const vus = new Set(donnees.map(d => String(d[champ] || "").slice(0, 10)));
  const manquants = [];
  for (let d = new Date(debut); d <= new Date(fin); d.setDate(d.getDate() + 1)) {
    const j = d.toISOString().slice(0, 10);
    if (!vus.has(j)) manquants.push(j);
  }
  return manquants;
}

if (typeof module !== "undefined") module.exports =
  { parseCSV, parser, detecterType, recouperSynthese, joursManquants, num, M };
