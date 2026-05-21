// parser.js — lecture Excel Aedes + normalisation + mapping branches
// Dépend de SheetJS (global XLSX) chargé via CDN dans index.html.

let BRANCH_MAPPING = null;

export async function loadBranchMapping() {
  if (BRANCH_MAPPING) return BRANCH_MAPPING;
  const res = await fetch('./data/mapping-branches.json');
  if (!res.ok) throw new Error('mapping-branches.json introuvable');
  BRANCH_MAPPING = await res.json();
  BRANCH_MAPPING._compiledPatterns = BRANCH_MAPPING.patterns.map(p => ({
    regex: new RegExp(p.regex, 'i'),
    branche: p.branche
  }));
  return BRANCH_MAPPING;
}

export function classifyBranche(produit) {
  if (!produit) return BRANCH_MAPPING?.default || 'Autre';
  const p = String(produit).trim();
  if (BRANCH_MAPPING.exact[p]) return BRANCH_MAPPING.exact[p];
  for (const { regex, branche } of BRANCH_MAPPING._compiledPatterns) {
    if (regex.test(p)) return branche;
  }
  return BRANCH_MAPPING.default;
}

export function normalizeGestionnaire(raw) {
  if (!raw) return 'Inconnu';
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Inconnu';
  const tokens = cleaned.split(' ');
  const upper = tokens.filter(t => t.length > 1 && t === t.toUpperCase() && /[A-ZÀ-Ü]/.test(t));
  const other = tokens.filter(t => !(t.length > 1 && t === t.toUpperCase() && /[A-ZÀ-Ü]/.test(t)));
  if (upper.length && other.length) {
    const prenom = other.map(capWord).join(' ');
    const nom = upper.map(capWord).join(' ');
    return `${prenom} ${nom}`;
  }
  return tokens.map(capWord).join(' ');
}
function capWord(w) {
  if (!w) return w;
  const lowers = ['de', 'du', 'la', 'le', 'van', 'von', 'des', "d'", "l'"];
  if (lowers.includes(w.toLowerCase())) return w.toLowerCase();
  // Gère les noms composés avec tiret (Ruiz-Ruiz, Van-Der-Weyde) en capitalisant chaque segment
  return w.split('-').map(part => {
    if (!part) return part;
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join('-');
}

export function excelDateToJS(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const iso = Date.parse(s);
    if (!isNaN(iso)) return new Date(iso);
    const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (m) {
      const [_, d, mo, y] = m;
      const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
      return new Date(year, parseInt(mo) - 1, parseInt(d));
    }
  }
  return null;
}

export function isPoliceActive(etatPaiement) {
  if (etatPaiement == null || etatPaiement === '') return true;
  const s = String(etatPaiement).toLowerCase();
  if (s.includes('résilia') || s.includes('resilia')) return false;
  if (s.includes('suspens')) return false;
  if (s.includes('mise sans suite') || s.includes('sans suite')) return false;
  if (s.includes('annul')) return false;
  return true;
}

/**
 * Parse la date depuis le nom de fichier. Format européen attendu : YYYY - DD-MM.xlsx
 * Ancré avant .xls/.xlsx pour éviter les faux matches sur milieu de nom.
 */
export function parseFilenameDate(filename) {
  if (!filename) return null;
  const m = filename.match(/(\d{4})\s*[-–—_]\s*(\d{1,2})\s*[-–—_]\s*(\d{1,2})\s*\.xlsx?$/i);
  if (m) {
    const [_, y, part1, part2] = m;
    const year = parseInt(y);
    let day = parseInt(part1);
    let month = parseInt(part2);
    if (month > 12 && day <= 12) { const tmp = month; month = day; day = tmp; }
    console.log(`[parser] parseFilenameDate("${filename}") → year=${year}, day=${day}, month=${month}`);
    return new Date(year, month - 1, day);
  }
  console.warn(`[parser] parseFilenameDate("${filename}") → no match, fallback to today`);
  return null;
}

/**
 * Extrait l'année depuis le nom de feuille ou retourne null.
 * Ex: "2025" → 2025, "Renouvellement 2024" → 2024, "2024 - PAC-AEDES" → 2024.
 */
function extractYearFromSheetName(sheetName) {
  const m = sheetName.match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1]) : null;
}

function isRenouvellementSheet(sheetName) {
  return /renouvellement/i.test(sheetName);
}

/**
 * Parse un fichier Aedes. Retourne un tableau de snapshots (un par feuille exploitable).
 * Chaque snapshot contient les polices + méta-données (year, type, sourceFilename, sheetName).
 */
export async function parseAedesFile(file) {
  await loadBranchMapping();
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });

  const snapshotDate = parseFilenameDate(file.name) || new Date();
  const results = [];

  for (const sheetName of wb.SheetNames) {
    const snap = parseSingleSheet(wb, sheetName, file.name, snapshotDate);
    if (snap) results.push(snap);
  }
  return results;
}

function parseSingleSheet(wb, sheetName, filename, snapshotDate) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 2) return null;

  // Certaines feuilles ont une colonne vide en tête → essaie ligne 0 puis ligne 1 comme en-têtes
  let headerRowIdx = 0;
  let headers = rows[headerRowIdx].map(h => String(h || '').trim());
  const sansHeader = headers.every(h => !h);
  if (sansHeader && rows.length > 1) {
    headerRowIdx = 1;
    headers = rows[headerRowIdx].map(h => String(h || '').trim());
  }

  const idx = findColumns(headers);

  // Minimum viable : il faut au moins Preneur + (PrimeHT ou PrimeTTC) + État paiement
  if (idx.preneur === -1) {
    console.warn(`[parser] Feuille "${sheetName}" ignorée : pas de colonne "Preneur"`);
    return null;
  }
  if (idx.primeHT === -1 && idx.primeTTC === -1) {
    console.warn(`[parser] Feuille "${sheetName}" ignorée : aucune colonne Prime HT ou TTC`);
    return null;
  }

  const polices = [];
  const unknownProducts = new Set();
  const warnings = [];
  const hasHT = idx.primeHT !== -1;
  // Conversion HT depuis TTC (TVA belge 21 %) faite silencieusement — pas de warning utilisateur
  if (!hasHT) console.log(`[parser] "${sheetName}" : conversion TTC→HT (÷ 1,21)`);

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const preneur = String(row[idx.preneur] || '').trim();
    if (!preneur) continue;

    const produit = idx.produit >= 0 ? String(row[idx.produit] || '').trim() : '';
    const branche = classifyBranche(produit);
    if (branche === BRANCH_MAPPING.default && produit) unknownProducts.add(produit);

    let primeHT = idx.primeHT >= 0 ? toNumber(row[idx.primeHT]) : 0;
    const primeTTC = idx.primeTTC >= 0 ? toNumber(row[idx.primeTTC]) : 0;
    // Fallback : si pas de HT, dériver depuis TTC (TVA belge 21 %)
    if (!primeHT && primeTTC) primeHT = primeTTC / 1.21;

    const etatPaiement = idx.etatPaiement >= 0 ? String(row[idx.etatPaiement] || '').trim() : '';
    const dateSouscription = idx.dateSouscription >= 0 ? excelDateToJS(row[idx.dateSouscription]) : null;

    polices.push({
      preneur,
      mail: idx.mail >= 0 ? String(row[idx.mail] || '').trim() : '',
      numContrat: idx.numContrat >= 0 ? String(row[idx.numContrat] || '').trim() : '',
      produit,
      branche,
      dateSouscription,
      primeHT,
      primeTTC,
      etatPaiement,
      active: isPoliceActive(etatPaiement),
      gestionnaire: normalizeGestionnaire(idx.gestionnaire >= 0 ? row[idx.gestionnaire] : ''),
      site: idx.site >= 0 ? String(row[idx.site] || '').trim() : ''
    });
  }

  const yearFromSheet = extractYearFromSheetName(sheetName) || snapshotDate.getFullYear();
  const type = isRenouvellementSheet(sheetName) ? 'renouvellement' : 'production';

  return {
    snapshotDate,
    year: yearFromSheet,
    type,               // 'production' ou 'renouvellement'
    sheetName,
    sourceFilename: filename,
    polices,
    unknownProducts,
    warnings
  };
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null || v === '') return 0;
  // On retire espaces + séparateurs de milliers. On accepte virgule OU point décimal.
  const s = String(v).trim().replace(/\s| /g, '').replace(',', '.');
  // Match STRICT : un vrai nombre (optionnel -, chiffres, optionnel décimales).
  // Rejette les strings contenant du texte (ex : "Recréation MA51006254" → 0, pas 51006254).
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function findColumns(headers) {
  const norm = h => String(h || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const normHeaders = headers.map(norm);
  const find = (patterns) => {
    for (const p of patterns) {
      const i = normHeaders.findIndex(h => h.includes(p));
      if (i !== -1) return i;
    }
    return -1;
  };
  return {
    preneur: find(['preneur']),
    mail: find(['mailclient', 'mail', 'email']),
    numContrat: find(['numerocontrat', 'numcontrat', 'nocontrat', 'contrat']),
    produit: find(['produit']),
    dateSouscription: find(['datesouscription', 'souscription']),
    datePriseEffet: find(['prisedeffet', 'priseeffet', 'priseeeffet', 'datedeffet', 'dateeffet']),
    primeHT: find(['primesannuellesht', 'primeannuelleht', 'primeht', 'primesht']),
    primeTTC: find(['primeannuellettc', 'primesannuellesttc', 'primettc', 'primesttc']),
    fractionnement: find(['fractionnement', 'fractio']),
    etatPaiement: find(['etatpaiement', 'etatdupaiement', 'statutpaiement', 'paiement']),
    datePaiement: find(['datepaiement', 'datedupaiement']),
    gestionnaire: find(['contactdap', 'contactdp', 'gestionnaire']),
    site: find(['sitedap', 'site', 'agence'])
  };
}
