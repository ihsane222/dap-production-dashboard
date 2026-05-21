// snapshots.js — gestion de l'historique en LocalStorage
// Clé = "aedes-snapshot-{year}-{sheetName slug}-{filename slug}"

const PREFIX = 'aedes-snapshot-';
const META_KEY = 'aedes-snapshot-meta';
const OVERRIDES_KEY = 'aedes-overrides';

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function saveSnapshot(parsed) {
  const key = `${PREFIX}${parsed.year}-${slug(parsed.sheetName)}-${slug(parsed.sourceFilename)}`;
  const compact = {
    key,
    snapshotDate: parsed.snapshotDate.toISOString(),
    year: parsed.year,
    type: parsed.type,
    sheetName: parsed.sheetName,
    sourceFilename: parsed.sourceFilename,
    polices: parsed.polices.map(p => ({
      preneur: p.preneur,
      numContrat: p.numContrat,
      produit: p.produit,
      branche: p.branche,
      dateSouscription: p.dateSouscription ? p.dateSouscription.toISOString() : null,
      primeHT: p.primeHT,
      primeTTC: p.primeTTC,
      active: p.active,
      gestionnaire: p.gestionnaire,
      site: p.site,
      etatPaiement: p.etatPaiement
    })),
    unknownProducts: [...(parsed.unknownProducts || [])],
    warnings: parsed.warnings || []
  };
  localStorage.setItem(key, JSON.stringify(compact));
  updateMeta(key, compact);
  return key;
}

export function loadSnapshot(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    obj.snapshotDate = new Date(obj.snapshotDate);
    obj.polices = obj.polices.map(p => ({
      ...p,
      dateSouscription: p.dateSouscription ? new Date(p.dateSouscription) : null
    }));
    return obj;
  } catch { return null; }
}

export function loadAllSnapshots() {
  return listSnapshotsMeta()
    .map(m => loadSnapshot(m.key))
    .filter(Boolean);
}

export function listSnapshotsMeta() {
  const meta = getMeta();
  return meta.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
}

export function deleteSnapshot(key) {
  localStorage.removeItem(key);
  const meta = getMeta().filter(m => m.key !== key);
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

export function clearAll() {
  for (const m of getMeta()) localStorage.removeItem(m.key);
  localStorage.removeItem(META_KEY);
  localStorage.removeItem(OVERRIDES_KEY);
}

/* ------- Overrides manuels (valeurs de référence de la convention) ------- */
export function getOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); } catch { return {}; }
}

export function setOverrides(obj) {
  // Filtre les valeurs vides/null/undefined pour ne pas forcer d'override
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '' && !Number.isNaN(v)) clean[k] = v;
  }
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(clean));
}

/* ------- interne ------- */
function getMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '[]'); } catch { return []; }
}
function updateMeta(key, compact) {
  const meta = getMeta().filter(m => m.key !== key);
  meta.push({
    key,
    snapshotDate: compact.snapshotDate,
    year: compact.year,
    type: compact.type,
    sheetName: compact.sheetName,
    sourceFilename: compact.sourceFilename,
    nbPolices: compact.polices.length
  });
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}
