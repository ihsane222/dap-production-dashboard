// charts.js — configuration Chart.js pour le dashboard DAP

const BLUE = '#1e3a8a';
const BLUE_SOFT = 'rgba(30, 58, 138, 0.08)';
const GRAY_LINE = '#cbd5e1';
const GRAY_TEXT = '#6b7280';
const GRID = '#f3f4f6';
const BRANCHE_COLORS = ['#1e3a8a', '#3b82f6', '#60a5fa', '#93c5fd', '#cbd5e1', '#94a3b8'];

const axisFont = { family: 'Inter', size: 11 };
let chartRefs = {};

/**
 * Détruit tous les charts existants avant un re-render.
 */
export function destroyAllCharts() {
  for (const k of Object.keys(chartRefs)) {
    try { chartRefs[k].destroy(); } catch {}
  }
  chartRefs = {};
}

export function renderLineProduction(canvas, { labels, dataN, dataN1, yearN, yearN1 }) {
  if (chartRefs.line) chartRefs.line.destroy();
  chartRefs.line = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: String(yearN),
          data: dataN,
          borderColor: BLUE,
          backgroundColor: BLUE_SOFT,
          fill: true,
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: BLUE,
          spanGaps: false
        },
        {
          label: String(yearN1),
          data: dataN1,
          borderColor: GRAY_LINE,
          backgroundColor: 'transparent',
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          align: 'end',
          labels: { color: '#374151', font: { family: 'Inter', size: 12, weight: '500' }, boxWidth: 12, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: ctx => ctx.raw == null ? null : `${ctx.dataset.label} : ${formatEur(ctx.raw)}`
          }
        }
      },
      scales: {
        x: { ticks: { color: GRAY_TEXT, font: axisFont }, grid: { display: false }, border: { color: '#e5e7eb' } },
        y: {
          ticks: { color: GRAY_TEXT, font: axisFont, callback: v => formatEurShort(v) },
          grid: { color: GRID }, beginAtZero: true, border: { display: false }
        }
      }
    }
  });
}

export function renderDonutBranches(canvas, rows) {
  if (chartRefs.donut) chartRefs.donut.destroy();
  chartRefs.donut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => r.branche),
      datasets: [{
        data: rows.map(r => r.prime),
        backgroundColor: BRANCHE_COLORS.slice(0, rows.length),
        borderColor: 'white',
        borderWidth: 3
      }]
    },
    options: {
      responsive: true,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.label} : ${formatEur(ctx.raw)} (${(ctx.raw / ctx.dataset.data.reduce((a,b)=>a+b,0) * 100).toFixed(1)} %)`
          }
        }
      }
    }
  });
}

/**
 * Génère le SVG d'une jauge radiale. Retourne une chaîne de balisage HTML à injecter.
 * Supporte: valeur actuelle, paliers (chaque palier = seuil × %), couleur active.
 */
export function radialGaugeHTML({ current, next, max, pct, color = BLUE, label }) {
  // Arc = 270° (du 135° au 45°, 75 % du cercle). circumference r=36 → 226.
  const CIRC = 226;
  const ARC = 170; // 75% arc
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const fillArc = ARC * ratio;
  return `
    <div class="radial">
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r="36" fill="none" stroke="#e5e7eb" stroke-width="8" stroke-dasharray="${ARC} ${CIRC}" stroke-linecap="round"/>
        <circle cx="44" cy="44" r="36" fill="none" stroke="${color}" stroke-width="8" stroke-dasharray="${fillArc} ${CIRC}" stroke-linecap="round"/>
      </svg>
      <div class="num-center${pct === 0 ? ' muted' : ''}" style="${pct > 0 ? `color:${color};` : ''}">${label}<span>${next}</span></div>
    </div>
  `;
}

/* ------- formatters utilitaires ------- */
export function formatEur(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('fr-BE', { maximumFractionDigits: 0 }).format(v) + ' €';
}
export function formatEurShort(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}
export function formatPct(v, decimals = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals).replace('.', ',') + ' %';
}
export function formatPctSigned(v, decimals = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v > 0 ? '+' : '';
  return s + v.toFixed(decimals).replace('.', ',') + ' %';
}
