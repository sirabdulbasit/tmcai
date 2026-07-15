/**
 * Self-contained HTML for the cost dashboard.
 *
 * Why a single inline HTML file: avoids depending on the Next.js client
 * build chain so admins can open the dashboard immediately — no rebuild,
 * no extra deployment. Chart.js comes from a CDN; everything else is
 * vanilla. All data fetched from the JSON endpoints in the same router,
 * scoped per-tenant by the bearer token.
 *
 * Future: when the Next.js client adds a proper React dashboard, we
 * point the route at the SPA route and remove this. Until then this
 * works end-to-end with no client-side dependencies.
 */
export function renderCostDashboardHtml(opts: {
  tenantNumber: string;
  isSuperAdmin: boolean;
  userName: string;
}): string {
  const { tenantNumber, isSuperAdmin, userName } = opts;

  // CSP gotcha: we use a `<script>` block + Chart.js from cdn.jsdelivr.net.
  // The app's CSP already allows 'self' + cdn.jsdelivr.net for scripts and
  // 'unsafe-inline' for styles. The inline script below requires
  // 'unsafe-inline' for scripts, which the app currently includes.

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyOS · Cost Dashboard · ${escapeHtml(tenantNumber)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0e1116;
    --panel: #141a22;
    --panel-2: #1b232d;
    --text: #e6e8eb;
    --text-dim: #98a0a8;
    --accent: #4fa9ff;
    --warn: #f0a14a;
    --danger: #d9534f;
    --ok: #4caf50;
    --border: #28323e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  header {
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { color: var(--text-dim); font-size: 12px; }
  .controls {
    padding: 14px 24px;
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .controls label { color: var(--text-dim); font-size: 12px; }
  .controls select, .controls button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .controls button:hover { border-color: var(--accent); }
  main {
    padding: 0 24px 32px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    min-height: 240px;
    display: flex;
    flex-direction: column;
  }
  .card.full-row { grid-column: 1 / -1; }
  .card h2 {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .card .big {
    font-size: 28px;
    font-weight: 600;
    margin: 4px 0;
  }
  .card .sub {
    font-size: 12px;
    color: var(--text-dim);
  }
  .card.banner-warn {
    border-color: var(--warn);
    background: linear-gradient(180deg, rgba(240,161,74,0.12), var(--panel));
  }
  .card.banner-danger {
    border-color: var(--danger);
    background: linear-gradient(180deg, rgba(217,83,79,0.18), var(--panel));
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table th { text-align: left; padding: 6px 8px; color: var(--text-dim); font-weight: 500; border-bottom: 1px solid var(--border); }
  table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  table tbody tr:last-child td { border-bottom: none; }
  table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .chart-wrap { flex: 1; position: relative; min-height: 220px; }
  .empty { color: var(--text-dim); font-size: 13px; padding: 24px 0; text-align: center; }
  footer { padding: 16px 24px; color: var(--text-dim); font-size: 11px; text-align: center; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--panel-2);
    color: var(--text-dim);
  }
  .pill.ok { background: rgba(76,175,80,0.15); color: var(--ok); }
  .pill.warn { background: rgba(240,161,74,0.18); color: var(--warn); }
  .pill.danger { background: rgba(217,83,79,0.18); color: var(--danger); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Cost Dashboard</h1>
    <div class="meta">Tenant <strong>${escapeHtml(tenantNumber)}</strong> · viewing as ${escapeHtml(userName)}${isSuperAdmin ? ' · <span class="pill">SuperAdmin</span>' : ''}</div>
  </div>
  <div id="anomaly-banner"></div>
</header>

<div class="controls">
  <label for="days-select">Window:</label>
  <select id="days-select">
    <option value="7">Last 7 days</option>
    <option value="14">Last 14 days</option>
    <option value="30" selected>Last 30 days</option>
    <option value="60">Last 60 days</option>
    <option value="90">Last 90 days</option>
  </select>
  <button id="refresh-btn">Refresh</button>
  <span class="meta" id="last-refresh"></span>
</div>

<main>
  <div class="card">
    <h2>Today's spend</h2>
    <div class="big" id="today-usd">$—</div>
    <div class="sub" id="today-sub"></div>
  </div>
  <div class="card">
    <h2>Trailing 7-day avg</h2>
    <div class="big" id="trailing-usd">$—</div>
    <div class="sub" id="trailing-sub"></div>
  </div>
  <div class="card">
    <h2>Total in window</h2>
    <div class="big" id="total-usd">$—</div>
    <div class="sub" id="total-sub"></div>
  </div>

  <div class="card full-row">
    <h2>Daily spend timeline</h2>
    <div class="chart-wrap"><canvas id="timeline-chart"></canvas></div>
  </div>

  <div class="card">
    <h2>By purpose</h2>
    <div class="chart-wrap"><canvas id="purpose-chart"></canvas></div>
  </div>

  <div class="card">
    <h2>By provider</h2>
    <div class="chart-wrap"><canvas id="provider-chart"></canvas></div>
  </div>

  <div class="card">
    <h2>Top users by spend</h2>
    <div id="users-table"></div>
  </div>

  ${isSuperAdmin ? `
  <div class="card full-row">
    <h2>Cross-tenant rollup (SuperAdmin)</h2>
    <div id="tenant-table"></div>
  </div>
  ` : ''}
</main>

<footer>
  Server-rendered cost dashboard · Data from Postgres <code>llm_spend</code> · Refreshes on demand
</footer>

<script>
const isSuperAdmin = ${isSuperAdmin ? 'true' : 'false'};
const $ = (sel) => document.querySelector(sel);
let charts = {};

function fmtUsd(n) {
  const v = Number(n || 0);
  if (v < 0.01) return '$0.00';
  if (v < 1) return '$' + v.toFixed(3);
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + Math.round(v).toLocaleString();
}
function fmtTokens(n) {
  const v = Number(n || 0);
  if (v < 1000) return v.toString();
  if (v < 1_000_000) return (v / 1000).toFixed(1) + 'K';
  return (v / 1_000_000).toFixed(2) + 'M';
}
function getToken() {
  // Token is expected in localStorage as 'token' (matches existing client
  // convention). Fallback: try cookie.
  const t = localStorage.getItem('token') || localStorage.getItem('auth_token');
  if (t) return t;
  const m = document.cookie.match(/(?:^|; )(?:token|auth_token)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function api(path) {
  const token = getToken();
  if (!token) {
    document.body.innerHTML = '<div style="padding:48px;text-align:center;color:#d9534f">No auth token found. Log in via the main app first, then reload this page.</div>';
    throw new Error('no token');
  }
  const r = await fetch('/api/v1/admin' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(r.status + ': ' + txt);
  }
  return r.json();
}

function renderAnomaly(data) {
  const banner = $('#anomaly-banner');
  const m = Number(data.multiple || 0);
  let pill = '';
  if (m === 0) pill = '<span class="pill">No baseline yet</span>';
  else if (m >= 2.5) pill = '<span class="pill danger">Anomaly: ' + m.toFixed(1) + 'x trailing avg</span>';
  else if (m >= 1.5) pill = '<span class="pill warn">Elevated: ' + m.toFixed(1) + 'x</span>';
  else pill = '<span class="pill ok">Normal (' + m.toFixed(1) + 'x)</span>';
  banner.innerHTML = pill;
  $('#today-usd').textContent = fmtUsd(data.today);
  $('#today-sub').textContent = m >= 2.5 ? 'Investigate runaway loop or check kill switch' : '';
  $('#trailing-usd').textContent = fmtUsd(data.trailingAvg);
  $('#trailing-sub').textContent = 'Daily mean over previous 7 days';
}

function renderTimeline(points) {
  const labels = points.map((p) => p.day);
  const usd = points.map((p) => Number(p.usd));
  const total = usd.reduce((a, b) => a + b, 0);
  $('#total-usd').textContent = fmtUsd(total);
  $('#total-sub').textContent = points.length + ' days · ' + fmtTokens(points.reduce((a, p) => a + Number(p.tokens || 0), 0)) + ' tokens';

  if (charts.timeline) charts.timeline.destroy();
  if (points.length === 0) {
    document.getElementById('timeline-chart').replaceWith(emptyDiv('No spend recorded in this window'));
    return;
  }
  charts.timeline = new Chart(document.getElementById('timeline-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'USD',
        data: usd,
        backgroundColor: '#4fa9ff',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#98a0a8', maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false } },
        y: { ticks: { color: '#98a0a8', callback: (v) => fmtUsd(v) }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

function renderPie(canvasId, rows, chartKey) {
  if (charts[chartKey]) charts[chartKey].destroy();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (rows.length === 0) {
    canvas.replaceWith(emptyDiv('No data'));
    return;
  }
  const labels = rows.map((r) => r.label || r.key || '(unknown)');
  const data = rows.map((r) => Number(r.usd));
  const palette = ['#4fa9ff', '#f0a14a', '#a47ad3', '#4caf50', '#ff7eb6', '#46c1bd', '#d9534f', '#cdd14a', '#7e8ce0', '#9caebc'];
  charts[chartKey] = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: rows.map((_, i) => palette[i % palette.length]),
        borderColor: '#141a22',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#e6e8eb', font: { size: 12 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => ctx.label + ': ' + fmtUsd(ctx.parsed) } },
      },
    },
  });
}

function renderUserTable(rows) {
  const c = $('#users-table');
  if (rows.length === 0) { c.innerHTML = '<div class="empty">No user spend in this window</div>'; return; }
  c.innerHTML = '<table>' +
    '<thead><tr><th>User</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">USD</th></tr></thead>' +
    '<tbody>' + rows.map((r) =>
      '<tr><td>' + escape(r.label || ('User #' + r.key)) + '</td>' +
      '<td class="num">' + r.calls + '</td>' +
      '<td class="num">' + fmtTokens(r.tokens) + '</td>' +
      '<td class="num">' + fmtUsd(r.usd) + '</td></tr>'
    ).join('') + '</tbody></table>';
}

function renderTenantTable(rows) {
  const c = $('#tenant-table');
  if (!c) return;
  if (rows.length === 0) { c.innerHTML = '<div class="empty">No spend across tenants in this window</div>'; return; }
  const total = rows.reduce((a, r) => a + Number(r.usd || 0), 0);
  c.innerHTML = '<table>' +
    '<thead><tr><th>Tenant</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">USD</th><th class="num">% of total</th></tr></thead>' +
    '<tbody>' + rows.map((r) => {
      const pct = total > 0 ? (Number(r.usd) / total * 100).toFixed(1) : '0.0';
      return '<tr><td>' + escape(r.clientNumber) + '</td>' +
        '<td class="num">' + r.calls + '</td>' +
        '<td class="num">' + fmtTokens(r.tokens) + '</td>' +
        '<td class="num">' + fmtUsd(r.usd) + '</td>' +
        '<td class="num">' + pct + '%</td></tr>';
    }).join('') + '</tbody></table>';
}

function emptyDiv(msg) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = msg;
  return d;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function refresh() {
  const days = parseInt($('#days-select').value, 10) || 30;
  $('#last-refresh').textContent = 'loading…';
  try {
    const [tl, byUser, byPurpose, byProvider, anomaly] = await Promise.all([
      api('/cost/timeline?days=' + days),
      api('/cost/by-user?days=' + days + '&limit=10'),
      api('/cost/by-purpose?days=' + days + '&limit=10'),
      api('/cost/by-provider?days=' + days),
      api('/cost/anomaly'),
    ]);
    renderAnomaly(anomaly);
    renderTimeline(tl.points || []);
    renderPie('purpose-chart', byPurpose.rows || [], 'purpose');
    renderPie('provider-chart', byProvider.rows || [], 'provider');
    renderUserTable(byUser.rows || []);
    if (isSuperAdmin) {
      const t = await api('/cost/per-tenant?days=' + days);
      renderTenantTable(t.rows || []);
    }
    $('#last-refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    $('#last-refresh').textContent = 'error: ' + err.message;
    console.error(err);
  }
}

$('#refresh-btn').addEventListener('click', refresh);
$('#days-select').addEventListener('change', refresh);
refresh();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
