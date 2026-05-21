// kpis.js — Calculs convention Aedes sur l'UNION de tous les snapshots uploadés.
// Modèle : chaque snapshot = 1 feuille d'un fichier Excel (production OU renouvellement).
// On cumule toutes les polices actives de tous les snapshots pour le Portefeuille.
// La Production d'une année = polices avec dateSouscription dans cette année-là.

export const PALIERS_PRODUCTION = [
  { seuil: 80000, pct: 1 },
  { seuil: 100000, pct: 2 },
  { seuil: 150000, pct: 3 }
];

export const PALIERS_CROISSANCE = [
  { seuil: 10, pct: 2 },
  { seuil: 20, pct: 4 },
  { seuil: 30, pct: 5 }
];

/**
 * computeKpisFromAll — prend l'ensemble des snapshots + les overrides optionnels.
 * Retourne un objet KPIs complet.
 *
 * @param {Array} snapshots — tableau de snapshots (chaque snapshot a .polices, .year, .type, etc.)
 * @param {Object} options
 *   @param {number} options.targetYear — année courante cible (défaut : plus récente trouvée)
 *   @param {Object} options.overrides — { productionOfficielle, portefeuilleOfficiel, croissanceOfficielle }
 */
/**
 * Priorité d'une feuille pour le dédoublonnage : plus la priorité est haute, plus la
 * donnée est "à jour". On privilégie les feuilles renouvellement de l'année récente
 * car elles contiennent les primes actualisées.
 *
 * Ex: un contrat signé en 2023 qui apparaît aussi dans "Renouvellement 2025" doit
 * prendre le montant de 2025 (plus récent) pas celui de 2023.
 */
function snapshotPriority(snapshot) {
  // Renouvellement prime la prod (même année) car plus récent
  const typeBonus = snapshot.type === 'renouvellement' ? 0.5 : 0;
  return snapshot.year + typeBonus;
}

export function computeKpisFromAll(snapshots, options = {}) {
  const overrides = options.overrides || {};

  // Fusionne toutes les polices avec source
  const allPolices = [];
  for (const s of snapshots) {
    const prio = snapshotPriority(s);
    for (const p of s.polices) {
      allPolices.push({
        ...p,
        _snapshotYear: s.year,
        _snapshotType: s.type,
        _snapshotDate: s.snapshotDate,
        _snapshotPriority: prio
      });
    }
  }

  const years = [...new Set(snapshots.map(s => s.year))].sort((a, b) => b - a);
  const targetYear = options.targetYear || years[0] || new Date().getFullYear();
  const mostRecentYear = years[0] || targetYear;
  // Les overrides (valeurs officielles convention) ne s'appliquent QU'à l'année la plus récente.
  // Pour les années passées, on lit directement les fichiers (données figées).
  const isCurrentYear = targetYear === mostRecentYear;
  const snapshotDate = snapshots.length
    ? new Date(Math.max(...snapshots.map(s => new Date(s.snapshotDate).getTime())))
    : new Date();

  // Dédoublonnage amélioré : priorité à la feuille la plus récente (année + renouvellement)
  const byContract = new Map();
  const noContract = [];
  for (const p of allPolices) {
    const key = (p.numContrat || '').trim();
    if (!key) { noContract.push(p); continue; }
    const existing = byContract.get(key);
    if (!existing || p._snapshotPriority > existing._snapshotPriority) {
      byContract.set(key, p);
    }
  }
  const policesUnique = [...byContract.values(), ...noContract];
  const policesActives = policesUnique.filter(p => p.active);

  // Prime Portefeuille calculé (union DÉDOUBLONNÉE des fichiers — une police comptée une fois)
  const portefeuilleCalcule = policesActives.reduce((s, p) => s + (p.primeHT || 0), 0);

  // Prime Production de l'année cible = polices actives SIGNÉES cette année-là.
  const productionPolices = allPolices
    .filter(p => p.active && p.dateSouscription && p.dateSouscription.getFullYear() === targetYear);
  const productionCalculee = productionPolices.reduce((s, p) => s + (p.primeHT || 0), 0);

  // L'override Production ne s'applique QU'à l'année courante (la plus récente).
  const production = (isCurrentYear && overrides.productionOfficielle != null)
    ? overrides.productionOfficielle
    : productionCalculee;

  // Croissance : override uniquement sur l'année courante
  const croissance = (isCurrentYear && overrides.croissanceOfficielle != null)
    ? overrides.croissanceOfficielle
    : null;

  // Prime Portefeuille : override et déduction uniquement sur l'année courante
  let portefeuille;
  let portefeuilleSource = 'calcule';
  if (isCurrentYear && overrides.portefeuilleOfficiel != null) {
    portefeuille = overrides.portefeuilleOfficiel;
    portefeuilleSource = 'override';
  } else if (isCurrentYear && overrides.portefeuilleN1 != null && croissance != null) {
    portefeuille = overrides.portefeuilleN1 * (1 + croissance / 100);
    portefeuilleSource = 'deduit';
  } else {
    portefeuille = portefeuilleCalcule;
    portefeuilleSource = 'calcule';
  }

  // Paliers
  const palierProduction = findPalier(production, PALIERS_PRODUCTION);
  const palierCroissance = croissance != null ? findPalier(croissance, PALIERS_CROISSANCE) : null;
  const prochainPalierProd = PALIERS_PRODUCTION.find(p => production < p.seuil) || null;
  const prochainPalierCrois = croissance != null ? PALIERS_CROISSANCE.find(p => croissance < p.seuil) : PALIERS_CROISSANCE[0];

  // FDG projeté
  const pctTotal = (palierProduction?.pct || 0) + (palierCroissance?.pct || 0);
  const fdgProjete = (pctTotal / 100) * portefeuille;

  return {
    snapshotDate,
    targetYear,
    mostRecentYear,
    isCurrentYear,
    allYears: years,
    nbSnapshots: snapshots.length,
    nbPolicesUniques: policesUnique.length,
    nbPolicesActives: policesActives.length,
    // Valeurs finales (override ou calcul)
    portefeuille,
    production,
    croissance,
    // Valeurs calculées (pour comparaison / debug)
    portefeuilleCalcule,
    productionCalculee,
    // Indicateurs d'override
    overridenProduction: overrides.productionOfficielle != null,
    overridenPortefeuille: portefeuilleSource === 'override',
    portefeuilleSource,                      // 'override' | 'deduit' | 'calcule'
    portefeuilleN1: overrides.portefeuilleN1 ?? null,
    overridenCroissance: overrides.croissanceOfficielle != null,
    // Paliers
    palierProduction,
    palierCroissance,
    prochainPalierProd,
    prochainPalierCrois,
    pctTotal,
    fdgProjete,
    simulations: computeSimulations(portefeuille),
    // Pour debug/affichage
    _policesActives: policesActives
  };
}

function findPalier(valeur, paliers) {
  let atteint = null;
  for (const p of paliers) {
    if (valeur >= p.seuil) atteint = p;
  }
  return atteint;
}

function computeSimulations(portefeuilleActuel) {
  return [
    { label: 'Palier 1 Prod + Palier 1 Crois', pct: 1 + 2, fdg: ((1 + 2) / 100) * portefeuilleActuel, hint: '≥ 80 000 € production ET > 10 % croissance' },
    { label: 'Palier 2 Prod + Palier 2 Crois', pct: 2 + 4, fdg: ((2 + 4) / 100) * portefeuilleActuel, hint: '≥ 100 000 € production ET > 20 % croissance' },
    { label: 'Palier 3 Prod + Palier 3 Crois', pct: 3 + 5, fdg: ((3 + 5) / 100) * portefeuilleActuel, hint: '≥ 150 000 € production ET > 30 % croissance' }
  ];
}

/**
 * Production cumulée par mois (1-12) pour l'année cible, depuis toutes les polices.
 */
export function productionMensuelleCumulee(policesActives, year) {
  const buckets = Array(12).fill(0);
  for (const p of policesActives) {
    if (!p.dateSouscription) continue;
    if (p.dateSouscription.getFullYear() !== year) continue;
    buckets[p.dateSouscription.getMonth()] += p.primeHT || 0;
  }
  const cumul = [];
  let acc = 0;
  for (let i = 0; i < 12; i++) { acc += buckets[i]; cumul.push(acc); }
  return cumul;
}

export function mixBranches(policesActives, year) {
  const map = new Map();
  for (const p of policesActives) {
    if (!p.dateSouscription || p.dateSouscription.getFullYear() !== year) continue;
    const key = p.branche || 'Autre';
    map.set(key, (map.get(key) || 0) + (p.primeHT || 0));
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  const rows = [...map.entries()]
    .map(([branche, prime]) => ({ branche, prime, pct: total > 0 ? (prime / total) * 100 : 0 }))
    .sort((a, b) => b.prime - a.prime);
  return { rows, total };
}

export function classementGestionnaires(policesActives, year) {
  const mapProd = new Map();
  const mapPort = new Map();
  const mapSites = new Map();
  for (const p of policesActives) {
    const g = p.gestionnaire || 'Inconnu';
    mapPort.set(g, (mapPort.get(g) || 0) + (p.primeHT || 0));
    if (p.site && !mapSites.has(g)) mapSites.set(g, p.site);
    if (p.dateSouscription && p.dateSouscription.getFullYear() === year) {
      mapProd.set(g, (mapProd.get(g) || 0) + (p.primeHT || 0));
    }
  }
  const totalProd = [...mapProd.values()].reduce((a, b) => a + b, 0);
  const totalPort = [...mapPort.values()].reduce((a, b) => a + b, 0);
  const allG = new Set([...mapProd.keys(), ...mapPort.keys()]);
  return [...allG].map(g => ({
    gestionnaire: g,
    site: mapSites.get(g) || '',
    production: mapProd.get(g) || 0,
    pctProduction: totalProd > 0 ? (mapProd.get(g) || 0) / totalProd * 100 : 0,
    portefeuille: mapPort.get(g) || 0,
    pctPortefeuille: totalPort > 0 ? (mapPort.get(g) || 0) / totalPort * 100 : 0
  })).sort((a, b) => b.production - a.production);
}
