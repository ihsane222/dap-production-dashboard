// ui.js — rendu DOM et interactions (UX refondue)
import { parseAedesFile } from './parser.js?v=11';
import {
  computeKpisFromAll, productionMensuelleCumulee, mixBranches, classementGestionnaires,
  PALIERS_PRODUCTION, PALIERS_CROISSANCE
} from './kpis.js?v=11';
import {
  saveSnapshot, loadSnapshot, loadAllSnapshots, listSnapshotsMeta, deleteSnapshot, clearAll,
  getOverrides, setOverrides, importSnapshot
} from './snapshots.js?v=11';
import {
  renderLineProduction, renderDonutBranches, radialGaugeHTML,
  formatEur, formatPct, formatPctSigned, destroyAllCharts
} from './charts.js?v=11';
import { pullAll, pushSnapshot, pushDelete, pushOverrides, CLOUD_OVERRIDES_KEY } from './sync.js?v=11';

const AVATAR_COLORS = ['#1e3a8a', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#dc2626', '#65a30d'];

/* ============================================================
 *  INIT
 * ============================================================ */
let currentView = 'production';
let chartRefs = {};  // références pour détruire les charts des autres vues

export function initUI() {
  setupUploadButtons();
  setupDragAndDrop();
  setupModal();
  setupOverrides();
  setupYearSelect();
  setupReset();
  setupNavigation();
  setupPortefeuilleFilters();
  setupHistoriqueCompare();
  setupSnapshotsLink();
  refresh();              // rendu immédiat des données locales
  syncFromCloud();        // puis fusion des données partagées (en arrière-plan)
}

/* ============================================================
 *  SYNC — données partagées entre collègues (webhook n8n)
 * ============================================================ */
async function syncFromCloud() {
  const months = await pullAll();
  let imported = 0;
  let cloudOverrides = null;

  for (const [key, val] of Object.entries(months)) {
    if (!val || typeof val !== 'object') continue;
    if (key === CLOUD_OVERRIDES_KEY) { cloudOverrides = val.overrides || null; continue; }
    // Snapshots au format réécriture (ont .key + .polices) ; les entrées
    // héritées de l'ancien dashboard (format agrégé, sans .polices) sont ignorées.
    if (Array.isArray(val.polices) && val.key) {
      if (importSnapshot(val)) imported++;
    }
  }

  // Les valeurs officielles partagées s'appliquent si rien n'a encore été saisi
  // en local (premier chargement) — on n'écrase pas une saisie locale en cours.
  if (cloudOverrides && Object.keys(getOverrides()).length === 0) {
    setOverrides(cloudOverrides);
  }

  if (imported > 0 || cloudOverrides) refresh();
}

/* ============================================================
 *  NAVIGATION ENTRE VUES
 * ============================================================ */
function setupNavigation() {
  document.querySelectorAll('#main-nav a[data-view]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.dataset.view;
      switchView(view);
    });
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('#main-nav a[data-view]').forEach(a => {
    a.classList.toggle('active', a.dataset.view === view);
  });
  document.querySelectorAll('.view[data-view]').forEach(v => {
    v.classList.toggle('hidden', v.dataset.view !== view);
  });
  // Le bandeau de fiabilité n'a de sens que pour la vue Production
  const banner = document.getElementById('reliability-banner');
  if (banner) banner.classList.toggle('hidden', view !== 'production');
  refresh();
}

function setupUploadButtons() {
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) handleUpload(files);
  });

  // Tous les boutons/zones qui ouvrent le file picker
  ['btn-upload', 'btn-browse', 'dropzone-big', 'dropzone-mini'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => {
      // Pour dropzone-big, ne pas déclencher si on clique sur le lien "parcourir"
      if (e.target.id === 'btn-browse') return;
      fileInput.click();
    });
  });
}

/* ============================================================
 *  DRAG & DROP (global + zones dédiées)
 * ============================================================ */
function setupDragAndDrop() {
  const overlay = document.getElementById('drop-overlay');
  const dropzoneBig = document.getElementById('dropzone-big');
  const dropzoneMini = document.getElementById('dropzone-mini');
  let dragCounter = 0;

  function hasFiles(e) {
    return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  }

  // Overlay global (sur toute la page)
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragCounter++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault(); // permet le drop
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.add('hidden');
    }
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.add('hidden');
    const files = [...e.dataTransfer.files].filter(f => /\.xlsx?$/i.test(f.name));
    if (files.length) handleUpload(files);
  });

  // Effet visuel sur les zones de drop dédiées
  [dropzoneBig, dropzoneMini].forEach(z => {
    if (!z) return;
    z.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      z.classList.add('dragover');
    });
    z.addEventListener('dragleave', () => z.classList.remove('dragover'));
    z.addEventListener('drop', () => z.classList.remove('dragover'));
  });
}

/* ============================================================
 *  MODAL D'IMPORT
 * ============================================================ */
const modal = {
  el: null,
  titleEl: null,
  listEl: null,
  summaryEl: null,
  doneBtn: null,
  closeBtn: null,
  open() { this.el.classList.remove('hidden'); },
  close() { this.el.classList.add('hidden'); },
  reset() {
    this.listEl.innerHTML = '';
    this.summaryEl.classList.add('hidden');
    this.summaryEl.className = 'import-summary hidden';
    this.doneBtn.disabled = true;
    this.titleEl.textContent = 'Import en cours…';
  },
  addFile(name) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="file-status pending"></span>
      <span>
        <div class="file-name">${escapeHtml(name)}</div>
        <div class="file-meta">Lecture en cours…</div>
      </span>
      <span class="file-count"></span>
    `;
    this.listEl.appendChild(li);
    return li;
  },
  updateFile(li, { status, meta, count }) {
    const st = li.querySelector('.file-status');
    st.className = 'file-status ' + status;
    st.textContent = status === 'success' ? '✓' : status === 'warn' ? '!' : status === 'error' ? '✕' : '';
    if (meta) li.querySelector('.file-meta').textContent = meta;
    if (count != null) li.querySelector('.file-count').textContent = count;
  },
  finish({ total, snapshots, warnings, errors }) {
    this.titleEl.textContent = 'Import terminé';
    this.doneBtn.disabled = false;
    this.summaryEl.classList.remove('hidden');
    let cls = '';
    let msg = `✓ ${total} fichier(s) traité(s) · ${snapshots} snapshot(s) créé(s)`;
    if (errors.length) {
      cls = 'has-errors';
      msg = `✕ ${errors.length} erreur(s) — ${snapshots} snapshot(s) créé(s) malgré tout`;
    } else if (warnings.length) {
      cls = 'has-warnings';
      msg = `⚠ ${warnings.length} avertissement(s) non bloquants — ${snapshots} snapshot(s) créé(s)`;
    }
    this.summaryEl.className = 'import-summary ' + cls;
    this.summaryEl.textContent = msg;
  }
};

function setupModal() {
  modal.el = document.getElementById('import-modal');
  modal.titleEl = document.getElementById('import-modal-title');
  modal.listEl = document.getElementById('import-file-list');
  modal.summaryEl = document.getElementById('import-summary');
  modal.doneBtn = document.getElementById('import-done-btn');
  modal.closeBtn = document.getElementById('import-modal-close');

  modal.doneBtn.addEventListener('click', () => modal.close());
  modal.closeBtn.addEventListener('click', () => modal.close());
  modal.el.querySelector('.modal-backdrop').addEventListener('click', () => {
    if (!modal.doneBtn.disabled) modal.close();
  });
}

/* ============================================================
 *  UPLOAD HANDLER (avec feedback par fichier)
 * ============================================================ */
async function handleUpload(files) {
  modal.reset();
  modal.open();

  let totalSnapshots = 0;
  const warnings = [];
  const errors = [];
  const savedKeys = [];

  for (const file of files) {
    const li = modal.addFile(file.name);
    try {
      const parsedArray = await parseAedesFile(file);
      if (!parsedArray.length) {
        modal.updateFile(li, { status: 'error', meta: 'Aucune feuille exploitable' });
        errors.push(`${file.name}: aucune feuille exploitable`);
        continue;
      }
      let fileSnapshotCount = 0;
      const fileWarnings = [];
      for (const parsed of parsedArray) {
        savedKeys.push(saveSnapshot(parsed));
        fileSnapshotCount++;
        totalSnapshots++;
        if (parsed.warnings.length) fileWarnings.push(...parsed.warnings);
      }
      if (fileWarnings.length) {
        warnings.push(...fileWarnings);
        modal.updateFile(li, {
          status: 'warn',
          meta: `${fileSnapshotCount} snapshot(s) · ${fileWarnings.length} avertissement(s)`,
          count: `${fileSnapshotCount} ✓`
        });
      } else {
        modal.updateFile(li, {
          status: 'success',
          meta: `${fileSnapshotCount} snapshot(s) créé(s)`,
          count: `${fileSnapshotCount} ✓`
        });
      }
    } catch (err) {
      console.error(err);
      modal.updateFile(li, { status: 'error', meta: err.message || 'Erreur inconnue' });
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  modal.finish({ total: files.length, snapshots: totalSnapshots, warnings, errors });
  refresh();

  // Partage : pousse les snapshots fraîchement importés vers le store commun
  for (const key of savedKeys) {
    const raw = localStorage.getItem(key);
    if (raw) pushSnapshot(JSON.parse(raw));
  }
}

/* ============================================================
 *  OVERRIDES (valeurs de référence de la convention)
 * ============================================================ */
function setupOverrides() {
  ['prod', 'port', 'crois', 'port-n1'].forEach(k => {
    const input = document.getElementById(`ovr-${k}`);
    if (input) {
      input.addEventListener('input', debounce(onOverrideChange, 400));
      input.addEventListener('change', onOverrideChange);
    }
  });
  document.getElementById('btn-clear-overrides').addEventListener('click', () => {
    setOverrides({});
    pushOverrides({});   // efface aussi les valeurs officielles partagées
    ['ovr-prod', 'ovr-port', 'ovr-crois', 'ovr-port-n1'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    refresh();
  });
}

function onOverrideChange() {
  const prod = parseFloat((document.getElementById('ovr-prod').value || '').replace(',', '.'));
  const port = parseFloat((document.getElementById('ovr-port').value || '').replace(',', '.'));
  const crois = parseFloat((document.getElementById('ovr-crois').value || '').replace(',', '.'));
  const portN1 = parseFloat((document.getElementById('ovr-port-n1').value || '').replace(',', '.'));
  setOverrides({
    productionOfficielle: Number.isFinite(prod) ? prod : null,
    portefeuilleOfficiel: Number.isFinite(port) ? port : null,
    croissanceOfficielle: Number.isFinite(crois) ? crois : null,
    portefeuilleN1: Number.isFinite(portN1) ? portN1 : null
  });
  pushOverrides(getOverrides());   // partage les valeurs officielles avec l'équipe
  refresh();
}

function setupYearSelect() {
  document.getElementById('year-select').addEventListener('change', refresh);
}

function setupReset() {
  document.getElementById('btn-reset').addEventListener('click', () => {
    // Dialogue custom simple
    if (window.confirm('Réinitialiser toutes les données du dashboard ?\nCette action est irréversible.')) {
      clearAll();
      location.reload();
    }
  });
}

function setupSnapshotsLink() {
  // Le bouton "Gérer les snapshots" switche vers la vue Historique
  const btn = document.getElementById('btn-goto-snapshots');
  if (btn) btn.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('historique');
  });
}

/* ============================================================
 *  REFRESH (re-render complet)
 * ============================================================ */
function refresh() {
  const meta = listSnapshotsMeta();
  const emptyEl = document.getElementById('empty-state');
  const dashEl = document.getElementById('dashboard');
  const sidebarCount = document.getElementById('sidebar-snapshot-count');
  const goto = document.getElementById('btn-goto-snapshots');

  // Compteur sidebar
  if (meta.length) {
    sidebarCount.textContent = meta.length;
    sidebarCount.classList.remove('hidden');
    goto.classList.remove('hidden');
    goto.textContent = `Gérer les snapshots (${meta.length})`;
  } else {
    sidebarCount.classList.add('hidden');
    goto.classList.add('hidden');
  }

  if (!meta.length) {
    emptyEl.classList.remove('hidden');
    dashEl.classList.add('hidden');
    destroyAllCharts();
    document.getElementById('page-title').textContent = 'Convention Aedes';
    document.getElementById('meta-line').textContent = 'Aucune donnée chargée — dépose des fichiers Excel pour commencer';
    return;
  }

  emptyEl.classList.add('hidden');
  dashEl.classList.remove('hidden');

  const snapshots = loadAllSnapshots();
  const overrides = getOverrides();
  syncOverrideInputs(overrides);

  const yearSelect = document.getElementById('year-select');
  const years = [...new Set(snapshots.map(s => s.year))].sort((a, b) => b - a);
  const currentValue = yearSelect.value;
  yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  if (currentValue && years.includes(parseInt(currentValue))) yearSelect.value = currentValue;
  const targetYear = parseInt(yearSelect.value) || years[0];

  const kpis = computeKpisFromAll(snapshots, {
    targetYear,
    overrides: {
      productionOfficielle: overrides.productionOfficielle,
      portefeuilleOfficiel: overrides.portefeuilleOfficiel,
      croissanceOfficielle: overrides.croissanceOfficielle
    }
  });

  renderPageTitle(kpis);

  if (currentView === 'production') {
    renderReliabilityBanner(kpis);
    renderKpis(kpis);
    renderLine(kpis, snapshots);
    renderMix(kpis);
    renderClassement(kpis);
    renderSimulations(kpis);
  } else if (currentView === 'portefeuille') {
    renderViewPortefeuille(kpis, snapshots);
  } else if (currentView === 'historique') {
    renderViewHistorique(kpis, snapshots, meta);
  }
}

function renderReliabilityBanner(k) {
  const el = document.getElementById('reliability-banner');
  if (!el) return;

  // Année passée : les valeurs de la convention ne s'appliquent pas
  if (!k.isCurrentYear) {
    el.innerHTML = `
      <h4 style="color: var(--gray-600);">Année ${k.targetYear} — vue archive</h4>
      <div>
        Les valeurs affichées sont lues directement depuis les fichiers.
        Pour revenir au suivi convention actif, sélectionne <b>${k.mostRecentYear}</b> dans le dropdown Année.
      </div>
    `;
    el.style.background = 'linear-gradient(to right, var(--gray-100), white)';
    el.style.borderColor = 'var(--gray-300)';
    el.classList.remove('hidden');
    return;
  }

  const croisOK = k.overridenCroissance;
  const portOK = k.portefeuilleSource === 'override' || k.portefeuilleSource === 'deduit';

  if (croisOK && portOK) {
    el.innerHTML = `
      <h4 style="color: var(--green);">Suivi complet</h4>
      <div>Les valeurs officielles de la convention sont à jour. Le FDG projeté reflète la réalité du mois.</div>
    `;
    el.style.background = 'linear-gradient(to right, var(--green-soft), white)';
    el.style.borderColor = 'var(--green)';
    el.classList.remove('hidden');
    return;
  }

  el.style.background = '';
  el.style.borderColor = '';
  const missing = [];
  if (!croisOK) missing.push('Croissance Portefeuille');
  if (!portOK) missing.push('Prime Portefeuille');

  el.innerHTML = `
    <h4>Pour affiner le suivi</h4>
    <div>
      La <b>Prime Production</b> est calculée automatiquement depuis les fichiers importés.
      Pour obtenir un <b>FDG projeté</b> conforme à la convention, renseigne les valeurs officielles
      de la <b>${missing.join(' et ')}</b> dans le panneau ci-dessous.
    </div>
  `;
  el.classList.remove('hidden');
}

/* ============================================================
 *  RENDERERS
 * ============================================================ */
function syncOverrideInputs(overrides) {
  const map = {
    'ovr-prod': overrides.productionOfficielle,
    'ovr-port': overrides.portefeuilleOfficiel,
    'ovr-crois': overrides.croissanceOfficielle,
    'ovr-port-n1': overrides.portefeuilleN1
  };
  for (const [id, val] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      el.value = val != null ? String(val) : '';
    }
  }
  // Affichage du portefeuille calculé quand Portefeuille N-1 + Croissance sont là
  const computed = document.getElementById('portefeuille-computed');
  if (!computed) return;
  if (overrides.portefeuilleN1 != null && overrides.croissanceOfficielle != null && overrides.portefeuilleOfficiel == null) {
    const actuel = overrides.portefeuilleN1 * (1 + overrides.croissanceOfficielle / 100);
    computed.classList.remove('hidden');
    document.getElementById('portefeuille-computed-value').textContent = formatEur(actuel);
    document.getElementById('portefeuille-n1-display').textContent = formatEur(overrides.portefeuilleN1);
    document.getElementById('croissance-display').textContent = formatPct(overrides.croissanceOfficielle, 2);
  } else {
    computed.classList.add('hidden');
  }
}

function renderPageTitle(k) {
  document.getElementById('page-title').textContent = `Convention Aedes ${k.targetYear}`;
  const d = k.snapshotDate.toLocaleDateString('fr-BE', { day: '2-digit', month: 'long', year: 'numeric' });
  document.getElementById('meta-line').innerHTML =
    `<b>${k.nbSnapshots}</b> snapshot(s) · <b>${k.nbPolicesUniques}</b> polices uniques · <b>${k.nbPolicesActives}</b> actives · dernière mise à jour <b>${d}</b>`;
}

function renderSnapshotList(meta) {
  const el = document.getElementById('snapshot-list');
  if (!el) return;
  if (!meta.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  // Grouper par année
  const byYear = new Map();
  for (const s of meta) {
    if (!byYear.has(s.year)) byYear.set(s.year, []);
    byYear.get(s.year).push(s);
  }
  const sortedYears = [...byYear.keys()].sort((a, b) => b - a);

  const groups = sortedYears.map(year => {
    const items = byYear.get(year).map(s => {
      const d = new Date(s.snapshotDate);
      const badge = s.type === 'renouvellement' ? 'RN' : 'NA';
      return `
        <div class="snapshot-item" data-key="${s.key}">
          <span class="badge ${badge}">${badge}</span>
          <span class="info">
            <b>${escapeHtml(s.sheetName)}</b>
            <div class="sub">${escapeHtml(s.sourceFilename)} · ${d.toLocaleDateString('fr-BE', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </span>
          <span class="count">${s.nbPolices} polices</span>
          <button class="btn-remove" data-del="${s.key}" title="Supprimer ce snapshot">×</button>
        </div>
      `;
    }).join('');
    return `
      <div class="snapshot-group">
        <div class="snapshot-group-title">Année ${year} · ${byYear.get(year).length} snapshot(s)</div>
        ${items}
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <h2 style="margin-bottom: 8px;">
      Snapshots chargés <span class="hint">${meta.length} total · NA = nouvelles affaires · RN = renouvellements</span>
    </h2>
    ${groups}
  `;

  // Suppression inline avec animation (pas de confirm natif)
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = btn.dataset.del;
      const row = btn.closest('.snapshot-item');
      row.classList.add('removing');
      setTimeout(() => {
        deleteSnapshot(key);
        pushDelete(key);   // propage la suppression au store partagé
        refresh();
      }, 200);
    });
  });
}

function renderKpis(k) {
  // Card 1 — Production (FIABLE)
  const maxProdPalier = PALIERS_PRODUCTION[PALIERS_PRODUCTION.length - 1].seuil;
  const ratioProd = Math.min(k.production / maxProdPalier, 1);
  const palierProdPct = k.palierProduction?.pct || 0;
  const prochainProd = k.prochainPalierProd;
  const resteProd = prochainProd ? prochainProd.seuil - k.production : 0;
  const overrideBadge = k.overridenProduction
    ? `<span class="pill blue" title="Valeur de référence saisie">RÉFÉRENCE</span>`
    : `<span class="pill green" title="Calculé directement depuis le fichier ${k.targetYear}">CALCULÉ</span>`;
  document.getElementById('kpi-production').innerHTML = `
    <div class="label">
      Prime Production ${k.targetYear}
      ${palierProdPct > 0 ? `<span class="pill green">Palier ${palierProdPct} % atteint</span>` : '<span class="pill gray">Palier 0</span>'}
    </div>
    <div class="value">${formatEur(k.production)} ${overrideBadge}</div>
    <div class="delta flat">${k.overridenProduction ? `Calcul auto : ${formatEur(k.productionCalculee)}` : `Calcul direct depuis fichier ${k.targetYear}`}</div>
    <div class="palier-info">
      <div class="txt">
        ${prochainProd
          ? `Palier ${prochainProd.pct} % à <b>${formatEur(prochainProd.seuil)}</b><br>Reste <b>${formatEur(resteProd)}</b>`
          : `<span class="achieved">Palier max atteint</span>`}
      </div>
      ${radialGaugeHTML({
        current: k.production, max: maxProdPalier,
        next: prochainProd ? `vers ${prochainProd.pct} %` : '3 % atteint',
        pct: palierProdPct, color: '#1e3a8a',
        label: Math.round(ratioProd * 100) + ' %'
      })}
    </div>
  `;

  // Card 2 — Croissance
  const maxCroisPalier = PALIERS_CROISSANCE[PALIERS_CROISSANCE.length - 1].seuil;
  const croissanceVal = k.croissance ?? 0;
  const ratioCrois = k.croissance != null ? Math.min(Math.max(croissanceVal, 0) / maxCroisPalier, 1) : 0;
  const palierCroisPct = k.palierCroissance?.pct || 0;
  const prochainCrois = k.prochainPalierCrois;
  const resteCrois = prochainCrois ? prochainCrois.seuil - croissanceVal : 0;
  document.getElementById('kpi-croissance').innerHTML = `
    <div class="label">
      Croissance Portefeuille
      ${k.croissance == null
        ? '<span class="pill amber">Non renseignée</span>'
        : palierCroisPct > 0
          ? `<span class="pill green">Palier ${palierCroisPct} % atteint</span>`
          : '<span class="pill gray">Palier 0</span>'}
    </div>
    <div class="value ${k.croissance == null ? 'muted' : ''}">${k.croissance == null ? '—' : formatPctSigned(k.croissance)}</div>
    <div class="delta flat">${k.croissance == null ? 'À renseigner dans le panneau ci-dessous' : 'Valeur de la convention'}</div>
    <div class="palier-info">
      <div class="txt">
        ${k.croissance == null
          ? 'La croissance n\'est pas calculable automatiquement.'
          : prochainCrois
            ? `Palier ${prochainCrois.pct} % à <b>+${prochainCrois.seuil} %</b><br>Reste <b>+${resteCrois.toFixed(1).replace('.', ',')} pts</b>`
            : '<span class="achieved">Palier max atteint</span>'}
      </div>
      ${radialGaugeHTML({
        current: Math.max(croissanceVal, 0), max: maxCroisPalier,
        next: prochainCrois ? `vers ${prochainCrois.seuil} %` : 'palier max',
        pct: palierCroisPct, color: '#059669',
        label: k.croissance == null ? '—' : Math.round(ratioCrois * 100) + ' %'
      })}
    </div>
  `;

  // Card 3 — FDG
  const fdgOverrideBadge = k.overridenPortefeuille
    ? `<span class="pill blue">Base convention</span>`
    : '';
  document.getElementById('kpi-fdg').innerHTML = `
    <div class="label">
      FDG Projeté au 31/12
      ${k.pctTotal > 0
        ? `<span class="pill green">${k.pctTotal} % × Portefeuille</span>`
        : '<span class="pill red">Aucun palier</span>'}
    </div>
    <div class="value ${k.pctTotal > 0 ? 'good' : 'muted'}">${formatEur(k.fdgProjete)}</div>
    <div class="delta flat">
      Portefeuille ${fdgOverrideBadge} : <b>${formatEur(k.portefeuille)}</b>
      ${k.overridenPortefeuille ? ` · calcul auto ${formatEur(k.portefeuilleCalcule)}` : ''}
    </div>
    <div class="palier-info">
      <div class="txt">
        ${k.pctTotal > 0
          ? `${(k.palierProduction?.pct || 0)} % prod + ${(k.palierCroissance?.pct || 0)} % crois`
          : `Si palier 1 + 1 :<br><b style="color:#059669;">${formatEur(0.03 * k.portefeuille)}</b>`}
      </div>
      ${radialGaugeHTML({
        current: k.pctTotal, max: 8, next: 'sur 8 % max',
        pct: k.pctTotal, color: '#059669',
        label: k.pctTotal + ' %'
      })}
    </div>
  `;
}

function renderLine(k, snapshots) {
  const policesAll = snapshots.flatMap(s => s.polices);
  const labels = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jui', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
  const dataN = productionMensuelleCumulee(policesAll.filter(p => p.active), k.targetYear);
  const dataN1 = productionMensuelleCumulee(policesAll.filter(p => p.active), k.targetYear - 1);
  if (k.targetYear === k.snapshotDate.getFullYear()) {
    const lastMonth = k.snapshotDate.getMonth();
    for (let i = lastMonth + 1; i < 12; i++) dataN[i] = null;
  }
  renderLineProduction(document.getElementById('chart-line'), {
    labels, dataN, dataN1, yearN: k.targetYear, yearN1: k.targetYear - 1
  });
}

function renderMix(k) {
  const { rows } = mixBranches(k._policesActives, k.targetYear);
  renderDonutBranches(document.getElementById('chart-donut'), rows);
  const legend = document.getElementById('donut-legend');
  const COLORS = ['#1e3a8a', '#3b82f6', '#60a5fa', '#93c5fd', '#cbd5e1', '#94a3b8'];
  legend.innerHTML = rows.length
    ? rows.map((r, i) => `
        <div class="donut-row">
          <span class="donut-dot" style="background:${COLORS[i] || '#cbd5e1'};"></span>
          <span class="donut-name">${escapeHtml(r.branche)}</span>
          <span class="donut-val">${formatEur(r.prime)}</span>
          <span class="donut-pct">${formatPct(r.pct)}</span>
        </div>
      `).join('')
    : '<div class="text-muted">Aucune production sur cette année.</div>';
}

function renderClassement(k) {
  const rows = classementGestionnaires(k._policesActives, k.targetYear);
  const maxProd = Math.max(...rows.map(r => r.production), 1);
  const tbody = document.getElementById('classement-body');
  tbody.innerHTML = rows.map((r, i) => {
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const initials = getInitials(r.gestionnaire);
    return `
      <tr>
        <td>
          <span class="mgr">
            <span class="avatar" style="background:${color};">${initials}</span>
            <span class="mgr-info">
              <b>${escapeHtml(r.gestionnaire)}</b>
              <span class="mgr-site">${escapeHtml(r.site || '—')}</span>
            </span>
          </span>
        </td>
        <td class="num">${formatEur(r.production)}</td>
        <td class="num">${formatPct(r.pctProduction)}</td>
        <td><span class="progress"><span class="progress-fill" style="width:${(r.production / maxProd * 100).toFixed(1)}%;"></span></span></td>
        <td class="num">${formatEur(r.portefeuille)}</td>
        <td class="num">${formatPct(r.pctPortefeuille)}</td>
      </tr>
    `;
  }).join('');
}

/* ============================================================
 *  VUE PORTEFEUILLE
 * ============================================================ */
let pfFilters = { search: '', branche: '', gestionnaire: '', type: '' };

function setupPortefeuilleFilters() {
  const s = document.getElementById('pf-search');
  const b = document.getElementById('pf-filter-branche');
  const g = document.getElementById('pf-filter-gestionnaire');
  const t = document.getElementById('pf-filter-type');
  if (!s) return;
  s.addEventListener('input', debounce(() => {
    pfFilters.search = s.value.trim().toLowerCase();
    refresh();
  }, 200));
  b.addEventListener('change', () => { pfFilters.branche = b.value; refresh(); });
  g.addEventListener('change', () => { pfFilters.gestionnaire = g.value; refresh(); });
  t.addEventListener('change', () => { pfFilters.type = t.value; refresh(); });
  document.getElementById('pf-export-btn')?.addEventListener('click', exportPortefeuilleCsv);
}

function renderViewPortefeuille(k, snapshots) {
  const polices = k._policesActives;
  const portefeuille = polices.reduce((s, p) => s + (p.primeHT || 0), 0);
  const targetYear = k.targetYear;
  const na = polices.filter(p => p.dateSouscription && p.dateSouscription.getFullYear() === targetYear);
  const rn = polices.filter(p => !p.dateSouscription || p.dateSouscription.getFullYear() !== targetYear);

  // Résumé
  document.getElementById('pf-polices-count').textContent = polices.length;
  document.getElementById('pf-polices-sub').textContent = `${na.length} nouvelles · ${rn.length} renouvellements`;
  document.getElementById('pf-prime-value').textContent = formatEur(portefeuille);
  document.getElementById('pf-prime-sub').textContent = `cumul sur ${polices.length} polices actives`;
  document.getElementById('pf-na-count').textContent = na.length;
  document.getElementById('pf-na-year').textContent = targetYear;
  document.getElementById('pf-na-sub').textContent = formatEur(na.reduce((s, p) => s + (p.primeHT || 0), 0)) + ' de prime';

  // Donut branches
  const brancheMap = new Map();
  for (const p of polices) {
    const k = p.branche || 'Autre';
    brancheMap.set(k, (brancheMap.get(k) || 0) + (p.primeHT || 0));
  }
  const rows = [...brancheMap.entries()]
    .map(([branche, prime]) => ({ branche, prime, pct: portefeuille > 0 ? prime / portefeuille * 100 : 0 }))
    .sort((a, b) => b.prime - a.prime);
  const COLORS = ['#1e3a8a', '#3b82f6', '#60a5fa', '#93c5fd', '#cbd5e1', '#94a3b8'];
  renderDonutBranches(document.getElementById('pf-chart-branches'), rows);
  document.getElementById('pf-branches-legend').innerHTML = rows.map((r, i) => `
    <div class="donut-row">
      <span class="donut-dot" style="background:${COLORS[i] || '#cbd5e1'};"></span>
      <span class="donut-name">${escapeHtml(r.branche)}</span>
      <span class="donut-val">${formatEur(r.prime)}</span>
      <span class="donut-pct">${formatPct(r.pct)}</span>
    </div>
  `).join('');

  // Top 10 clients
  const topClients = [...polices]
    .sort((a, b) => (b.primeHT || 0) - (a.primeHT || 0))
    .slice(0, 10);
  document.getElementById('pf-top-clients').innerHTML = topClients.map((p, i) => `
    <div class="top-client-row">
      <span class="rank">${String(i + 1).padStart(2, '0')}</span>
      <span>
        <div class="name">${escapeHtml(p.preneur)}</div>
        <div class="sub">${escapeHtml(p.produit || '—')} · ${escapeHtml(p.branche || 'Autre')} · ${escapeHtml(p.gestionnaire || '—')}</div>
      </span>
      <span class="amount">${formatEur(p.primeHT || 0)}</span>
    </div>
  `).join('');

  // Alimente les dropdowns de filtres (branches + gestionnaires)
  const branches = [...new Set(polices.map(p => p.branche || 'Autre'))].sort();
  const gestionnaires = [...new Set(polices.map(p => p.gestionnaire || 'Inconnu'))].sort();
  const currentBr = document.getElementById('pf-filter-branche').value;
  const currentGe = document.getElementById('pf-filter-gestionnaire').value;
  document.getElementById('pf-filter-branche').innerHTML =
    `<option value="">Toutes les branches</option>` + branches.map(b => `<option value="${escapeHtml(b)}" ${currentBr === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('');
  document.getElementById('pf-filter-gestionnaire').innerHTML =
    `<option value="">Tous les gestionnaires</option>` + gestionnaires.map(g => `<option value="${escapeHtml(g)}" ${currentGe === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('');

  // Tableau filtré
  const filtered = polices.filter(p => {
    if (pfFilters.branche && (p.branche || 'Autre') !== pfFilters.branche) return false;
    if (pfFilters.gestionnaire && (p.gestionnaire || 'Inconnu') !== pfFilters.gestionnaire) return false;
    if (pfFilters.type === 'NA' && (!p.dateSouscription || p.dateSouscription.getFullYear() !== targetYear)) return false;
    if (pfFilters.type === 'RN' && p.dateSouscription && p.dateSouscription.getFullYear() === targetYear) return false;
    if (pfFilters.search) {
      const hay = (p.preneur + ' ' + (p.numContrat || '') + ' ' + (p.gestionnaire || '') + ' ' + (p.produit || '')).toLowerCase();
      if (!hay.includes(pfFilters.search)) return false;
    }
    return true;
  });

  document.getElementById('pf-count-hint').textContent = `${filtered.length} / ${polices.length} polices · ${formatEur(filtered.reduce((s, p) => s + (p.primeHT || 0), 0))}`;

  const body = document.getElementById('pf-polices-body');
  body.innerHTML = filtered.slice(0, 500).map(p => {
    const isNA = p.dateSouscription && p.dateSouscription.getFullYear() === targetYear;
    const tag = isNA ? `<span class="tag na">NA</span>` : `<span class="tag rn">RN</span>`;
    const etat = (p.etatPaiement || '').toUpperCase();
    const etatTag = etat === 'OK' ? `<span class="tag ok">${etat}</span>`
      : etat === 'NO' ? `<span class="tag pending">${etat}</span>`
      : etat ? `<span class="tag muted">${etat}</span>`
      : `<span class="tag muted">—</span>`;
    return `
      <tr>
        <td><b>${escapeHtml(p.preneur)}</b></td>
        <td class="mono">${escapeHtml(p.numContrat || '—')}</td>
        <td>${escapeHtml(p.produit || '—')}</td>
        <td>${escapeHtml(p.branche || 'Autre')}</td>
        <td>${tag}</td>
        <td>${p.dateSouscription ? p.dateSouscription.toLocaleDateString('fr-BE') : '—'}</td>
        <td class="num">${formatEur(p.primeHT || 0)}</td>
        <td>${escapeHtml(p.gestionnaire || '—')}</td>
        <td>${etatTag}</td>
      </tr>
    `;
  }).join('') + (filtered.length > 500 ? `<tr><td colspan="9" style="text-align:center; color: var(--gray-500); padding: 16px;">… ${filtered.length - 500} polices supplémentaires non affichées (affine les filtres)</td></tr>` : '');
}

function exportPortefeuilleCsv() {
  const rows = document.querySelectorAll('#pf-polices-body tr');
  const headers = ['Preneur', 'N° contrat', 'Produit', 'Branche', 'Type', 'Date souscription', 'Prime HT', 'Gestionnaire', 'État'];
  const lines = [headers.join(';')];
  rows.forEach(tr => {
    const cols = [...tr.querySelectorAll('td')].map(td => {
      const txt = td.innerText.replace(/\s+/g, ' ').trim();
      return /[;"\n]/.test(txt) ? `"${txt.replace(/"/g, '""')}"` : txt;
    });
    if (cols.length) lines.push(cols.join(';'));
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `portefeuille-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

/* ============================================================
 *  VUE HISTORIQUE
 * ============================================================ */
let histCompare = { a: null, b: null };

function setupHistoriqueCompare() {
  const a = document.getElementById('hist-comp-a');
  const b = document.getElementById('hist-comp-b');
  if (!a || !b) return;
  a.addEventListener('change', () => { histCompare.a = a.value; renderComparator(); });
  b.addEventListener('change', () => { histCompare.b = b.value; renderComparator(); });
}

function renderViewHistorique(k, snapshots, meta) {
  // Résumé
  document.getElementById('hist-count').textContent = meta.length;
  const dates = meta.map(m => new Date(m.snapshotDate));
  if (dates.length) {
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    document.getElementById('hist-range').textContent = `du ${min.toLocaleDateString('fr-BE')} au ${max.toLocaleDateString('fr-BE')}`;
  } else document.getElementById('hist-range').textContent = '—';

  const years = [...new Set(meta.map(m => m.year))].sort((a,b) => a-b);
  document.getElementById('hist-years').textContent = years.length ? `${years[0]}–${years[years.length-1]}` : '—';
  document.getElementById('hist-unique').textContent = k.nbPolicesUniques;

  // Graphe évolution annuelle (production par année)
  renderYearlyChart(snapshots);

  // Timeline (groupée par année)
  renderTimeline(meta);

  // Comparateur
  populateCompareSelects(meta);
  renderComparator();
}

function renderYearlyChart(snapshots) {
  // Production (primes actives) par année de souscription (toutes polices confondues)
  const byYear = new Map();
  const byYearCount = new Map();
  const allPolices = snapshots.flatMap(s => s.polices);

  // Dédup par n° contrat pour ne pas compter les renouvellements comme nouvelles affaires
  const byContract = new Map();
  for (const p of allPolices) {
    if (!p.active) continue;
    if (!p.dateSouscription) continue;
    const k = (p.numContrat || '').trim();
    if (!k) continue;
    const existing = byContract.get(k);
    if (!existing || p.dateSouscription < existing.dateSouscription) byContract.set(k, p);  // version originale (première signature)
  }

  for (const p of byContract.values()) {
    const y = p.dateSouscription.getFullYear();
    byYear.set(y, (byYear.get(y) || 0) + (p.primeHT || 0));
    byYearCount.set(y, (byYearCount.get(y) || 0) + 1);
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const canvas = document.getElementById('hist-chart-yearly');
  if (!canvas) return;
  if (chartRefs.yearly) { try { chartRefs.yearly.destroy(); } catch {} }

  chartRefs.yearly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: years.map(String),
      datasets: [
        {
          label: 'Prime HT signée',
          data: years.map(y => byYear.get(y)),
          backgroundColor: '#1e3a8a',
          borderRadius: 4,
          yAxisID: 'y'
        },
        {
          label: 'Nb polices',
          data: years.map(y => byYearCount.get(y)),
          type: 'line',
          borderColor: '#d97706',
          backgroundColor: 'transparent',
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#d97706',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { align: 'end', labels: { color: '#374151', font: { family: 'Inter', size: 12, weight: '500' }, boxWidth: 12, usePointStyle: true }}
      },
      scales: {
        x: { ticks: { color: '#6b7280', font: { family: 'Inter', size: 11 }}, grid: { display: false }},
        y: {
          type: 'linear', position: 'left',
          ticks: { color: '#6b7280', font: { family: 'Inter', size: 11 }, callback: v => (v/1000) + 'k' },
          grid: { color: '#f3f4f6' }, beginAtZero: true
        },
        y1: {
          type: 'linear', position: 'right',
          ticks: { color: '#6b7280', font: { family: 'Inter', size: 11 }},
          grid: { display: false }, beginAtZero: true
        }
      }
    }
  });
  canvas.style.maxHeight = '320px';
}

function renderTimeline(meta) {
  const el = document.getElementById('hist-timeline');
  if (!el) return;
  if (!meta.length) { el.innerHTML = '<div class="text-muted">Aucun snapshot.</div>'; return; }

  const byYear = new Map();
  for (const s of meta) {
    if (!byYear.has(s.year)) byYear.set(s.year, []);
    byYear.get(s.year).push(s);
  }
  const years = [...byYear.keys()].sort((a,b) => b-a);

  el.innerHTML = years.map(year => {
    const list = byYear.get(year);
    const totalPolices = list.reduce((s, m) => s + m.nbPolices, 0);
    const items = list.map(s => {
      const d = new Date(s.snapshotDate);
      const badge = s.type === 'renouvellement' ? 'RN' : 'NA';
      return `
        <div class="snapshot-item" data-key="${s.key}">
          <span class="badge ${badge}">${badge}</span>
          <span class="info">
            <b>${escapeHtml(s.sheetName)}</b>
            <div class="sub">${escapeHtml(s.sourceFilename)} · ${d.toLocaleDateString('fr-BE', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </span>
          <span class="count">${s.nbPolices} polices</span>
          <button class="btn-remove" data-del="${s.key}" title="Supprimer ce snapshot">×</button>
        </div>
      `;
    }).join('');
    return `
      <div class="timeline-year">
        <div class="timeline-year-header">
          <span class="year-badge">${year}</span>
          <span class="year-stats">${list.length} snapshot(s) · ${totalPolices} polices au total</span>
        </div>
        ${items}
      </div>
    `;
  }).join('');

  // Handlers suppression
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.del;
      const row = btn.closest('.snapshot-item');
      row.classList.add('removing');
      setTimeout(() => { deleteSnapshot(key); pushDelete(key); refresh(); }, 200);
    });
  });
}

function populateCompareSelects(meta) {
  const a = document.getElementById('hist-comp-a');
  const b = document.getElementById('hist-comp-b');
  if (!a || !b) return;
  const options = meta.map(s => {
    const d = new Date(s.snapshotDate);
    return `<option value="${s.key}">${s.year} · ${s.sheetName} · ${d.toLocaleDateString('fr-BE')}</option>`;
  }).join('');
  a.innerHTML = '<option value="">— Choisir un snapshot —</option>' + options;
  b.innerHTML = '<option value="">— Choisir un snapshot —</option>' + options;
  // Restore selection if valid
  if (histCompare.a && meta.find(m => m.key === histCompare.a)) a.value = histCompare.a;
  if (histCompare.b && meta.find(m => m.key === histCompare.b)) b.value = histCompare.b;
}

function renderComparator() {
  const el = document.getElementById('hist-comp-result');
  if (!el) return;
  if (!histCompare.a || !histCompare.b) {
    el.innerHTML = '<div class="text-muted" style="padding: 12px 0;">Sélectionne 2 snapshots ci-dessus pour voir le delta.</div>';
    return;
  }
  if (histCompare.a === histCompare.b) {
    el.innerHTML = '<div class="text-muted" style="padding: 12px 0;">Les 2 snapshots sélectionnés sont identiques.</div>';
    return;
  }
  const snapA = loadSnapshot(histCompare.a);
  const snapB = loadSnapshot(histCompare.b);
  if (!snapA || !snapB) { el.innerHTML = '<div class="text-muted">Snapshot introuvable.</div>'; return; }

  const activeA = snapA.polices.filter(p => p.active);
  const activeB = snapB.polices.filter(p => p.active);
  const primeA = activeA.reduce((s, p) => s + (p.primeHT || 0), 0);
  const primeB = activeB.reduce((s, p) => s + (p.primeHT || 0), 0);

  // Diff par n° contrat
  const keysA = new Set(activeA.map(p => (p.numContrat || '').trim()).filter(Boolean));
  const keysB = new Set(activeB.map(p => (p.numContrat || '').trim()).filter(Boolean));
  const entrees = [...keysB].filter(k => !keysA.has(k)).length;
  const sorties = [...keysA].filter(k => !keysB.has(k)).length;
  const commun = [...keysB].filter(k => keysA.has(k)).length;

  const deltaPrime = primeB - primeA;
  const deltaPct = primeA > 0 ? ((primeB - primeA) / primeA * 100) : null;
  const deltaPolices = activeB.length - activeA.length;

  el.innerHTML = `
    <div class="compare-result">
      <div class="compare-cell ${deltaPolices > 0 ? 'up' : deltaPolices < 0 ? 'down' : ''}">
        <div class="label">Polices actives</div>
        <div class="value">${activeA.length} → ${activeB.length}</div>
        <div class="sub">${deltaPolices >= 0 ? '+' : ''}${deltaPolices} ${Math.abs(deltaPolices) > 1 ? 'polices' : 'police'}</div>
      </div>
      <div class="compare-cell ${deltaPrime > 0 ? 'up' : deltaPrime < 0 ? 'down' : ''}">
        <div class="label">Prime cumulée</div>
        <div class="value">${formatEur(deltaPrime >= 0 ? deltaPrime : -deltaPrime)}${deltaPrime >= 0 ? ' ↑' : ' ↓'}</div>
        <div class="sub">${formatEur(primeA)} → ${formatEur(primeB)}${deltaPct != null ? ' · ' + formatPctSigned(deltaPct) : ''}</div>
      </div>
      <div class="compare-cell up">
        <div class="label">Entrées</div>
        <div class="value">+${entrees}</div>
        <div class="sub">nouveaux contrats dans B</div>
      </div>
      <div class="compare-cell down">
        <div class="label">Sorties</div>
        <div class="value">-${sorties}</div>
        <div class="sub">contrats disparus de B</div>
      </div>
      <div class="compare-cell">
        <div class="label">Contrats communs</div>
        <div class="value">${commun}</div>
        <div class="sub">présents dans A et B</div>
      </div>
    </div>
  `;
}

function renderSimulations(k) {
  const el = document.getElementById('simulations');
  el.innerHTML = k.simulations.map(s => `
    <div class="donut-row" style="padding: 8px 0; border-bottom: 1px solid var(--gray-100);">
      <span class="donut-dot" style="background:var(--green);"></span>
      <span class="donut-name">${s.label}</span>
      <span class="donut-val" style="font-size:11px;">${s.hint}</span>
      <span class="donut-pct" style="color:var(--green);">${formatEur(s.fdg)}</span>
    </div>
  `).join('');
}

/* ============================================================
 *  HELPERS
 * ============================================================ */
function getInitials(name) {
  if (!name) return '?';
  const parts = name.split(/[\s-]+/).filter(p => p.length > 1);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
