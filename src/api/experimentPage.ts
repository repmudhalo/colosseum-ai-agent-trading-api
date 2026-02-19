export function renderExperimentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sesame — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0f;
  --bg2:#111118;
  --bg3:#16161f;
  --card:#12121a;
  --border:#1e1e2a;
  --accent:#c8ff00;
  --accent-dim:rgba(200,255,0,.12);
  --red:#ef4444;
  --green:#22c55e;
  --cyan:#06b6d4;
  --text:#e4e4e7;
  --muted:#71717a;
  --mono:'SF Mono',Monaco,Consolas,'Liberation Mono',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,sans-serif;
}
html{scroll-behavior:smooth}
body{font-family:var(--sans);background:var(--bg);color:var(--text);min-height:100vh}

/* ── Layout ── */
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
@media(max-width:800px){.shell{grid-template-columns:1fr}}

/* ── Sidebar ── */
.sidebar{background:var(--bg2);border-right:1px solid var(--border);padding:1.5rem 1rem;display:flex;flex-direction:column;gap:2rem}
@media(max-width:800px){.sidebar{display:none}}
.logo{font-size:1.1rem;font-weight:700;letter-spacing:-.5px;color:#fff;display:flex;align-items:center;gap:8px}
.logo svg{width:22px;height:22px;fill:var(--accent)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:.82rem;font-weight:500;color:var(--muted);cursor:default;transition:background .15s,color .15s}
.nav-item.active{background:var(--accent-dim);color:var(--accent)}
.nav-item svg{width:16px;height:16px;flex-shrink:0;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.nav-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);padding:0 12px;margin-top:.5rem}

/* ── Main ── */
.main{padding:2rem 2.5rem;overflow-y:auto}
@media(max-width:800px){.main{padding:1.2rem}}
.page-title{font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:.25rem}
.page-sub{font-size:.82rem;color:var(--muted);margin-bottom:1.5rem}

/* ── Cards ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.card-title{font-size:.82rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.card-title svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* ── Stat values ── */
.stat-big{font-size:1.8rem;font-weight:700;color:#fff;font-family:var(--mono);letter-spacing:-.5px}
.stat-label{font-size:.72rem;color:var(--muted);margin-top:2px}
.stat-row{display:flex;align-items:baseline;gap:6px}

/* ── Grids ── */
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem}
@media(max-width:900px){.grid-3,.grid-2{grid-template-columns:1fr}}

/* ── Wallet header ── */
.wallet-bar{display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:1.5rem;flex-wrap:wrap}
.wallet-address{font-family:var(--mono);font-size:.82rem;color:var(--cyan);letter-spacing:.3px}
.wallet-copy{background:none;border:1px solid var(--border);color:var(--muted);padding:4px 10px;border-radius:6px;font-size:.7rem;cursor:pointer;transition:all .15s}
.wallet-copy:hover{border-color:var(--accent);color:var(--accent)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot-ok{background:var(--green);box-shadow:0 0 6px rgba(34,197,94,.4)}
.dot-off{background:var(--red);box-shadow:0 0 6px rgba(239,68,68,.3)}

/* ── Trades table ── */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead th{text-align:left;padding:8px 12px;font-weight:600;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
tbody td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
tbody tr:hover{background:rgba(255,255,255,.02)}
.token-name{font-weight:600;color:#fff}
.token-mint{font-family:var(--mono);font-size:.68rem;color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600;text-transform:uppercase}
.badge-buy{background:rgba(34,197,94,.12);color:var(--green)}
.badge-sell{background:rgba(239,68,68,.12);color:var(--red)}
.badge-open{background:rgba(6,182,212,.12);color:var(--cyan)}
.badge-moon{background:rgba(200,255,0,.12);color:var(--accent)}
.pnl-pos{color:var(--green);font-weight:600;font-family:var(--mono)}
.pnl-neg{color:var(--red);font-weight:600;font-family:var(--mono)}
.pnl-zero{color:var(--muted);font-family:var(--mono)}
.empty-state{padding:2rem;text-align:center;color:var(--muted);font-size:.82rem}

/* ── Feed ── */
.feed{max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:0}
.feed::-webkit-scrollbar{width:3px}
.feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.feed-item{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:.78rem}
.feed-item:last-child{border-bottom:none}
.feed-time{font-family:var(--mono);font-size:.68rem;color:var(--muted);white-space:nowrap;min-width:62px}
.feed-event{font-weight:600;min-width:110px}
.feed-detail{color:var(--muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.event-featured{color:var(--accent)}
.event-moved{color:var(--cyan)}
.event-reentry{color:#a78bfa}
.event-removed{color:var(--red)}
.event-candidates{color:var(--muted)}
.event-unknown{color:var(--muted)}

/* ── KV helper ── */
.kv-list{display:flex;flex-direction:column;gap:6px}
.kv{display:flex;justify-content:space-between;align-items:center}
.kv .k{color:var(--muted);font-size:.78rem}
.kv .v{color:var(--text);font-size:.78rem;font-weight:600;font-family:var(--mono)}

/* ── Scrollbar global ── */
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
</style>
</head>
<body>
<div class="shell">

  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="logo">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5" stroke="#0a0a0f" stroke-width="2.5" fill="none"/></svg>
      Sesame
    </div>

    <nav class="nav">
      <div class="nav-item active">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Dashboard
      </div>
      <div class="nav-item" onclick="window.open('/snipe/portfolio','_blank')">
        <svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>
        Portfolio
      </div>
      <div class="nav-item" onclick="window.open('/snipe/trades','_blank')">
        <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Trade History
      </div>
      <div class="nav-item" onclick="window.open('/snipe/strategy','_blank')">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Strategy
      </div>
    </nav>

    <div class="nav-label">Integrations</div>
    <nav class="nav">
      <div class="nav-item" onclick="window.open('/lore/status','_blank')">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        LORE
      </div>
      <div class="nav-item" onclick="window.open('/health','_blank')">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        Health
      </div>
    </nav>

    <div style="margin-top:auto;padding:8px 12px;font-size:.68rem;color:var(--muted)">
      <span id="sidebar-uptime">--</span> uptime
    </div>
  </aside>

  <!-- Main content -->
  <main class="main">
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Trading bot overview, live positions, and incoming LORE signals.</div>

    <!-- Wallet bar -->
    <div class="wallet-bar" id="wallet-bar">
      <span id="wallet-dot"><span class="dot dot-off"></span></span>
      <span id="wallet-status" style="font-size:.78rem;font-weight:600">Connecting...</span>
      <span class="wallet-address" id="wallet-addr">--</span>
      <button class="wallet-copy" id="copy-btn" onclick="copyAddr()">Copy</button>
      <span style="margin-left:auto;font-family:var(--mono);font-size:.82rem;font-weight:700;color:#fff" id="sol-balance">-- SOL</span>
    </div>

    <!-- Stats row -->
    <div class="grid-3" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>
          Open positions
        </div>
        <div class="stat-big" id="stat-open">--</div>
        <div class="stat-label">Currently held tokens</div>
      </div>
      <div class="card">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Total trades
        </div>
        <div class="stat-big" id="stat-trades">--</div>
        <div class="stat-label">Buys + sells + auto-exits</div>
      </div>
      <div class="card">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          Realized P&L
        </div>
        <div class="stat-big" id="stat-pnl">--</div>
        <div class="stat-label">SOL (closed positions)</div>
      </div>
    </div>

    <!-- Active positions table -->
    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          Active positions
        </div>
        <button class="wallet-copy" onclick="loadPositions()">Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>SOL in</th>
              <th>Entry</th>
              <th>Current</th>
              <th>P&L</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="positions-body">
            <tr><td colspan="7" class="empty-state">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Bottom row: LORE feed + LORE config -->
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            LORE signals
          </div>
          <span style="font-size:.68rem;color:var(--muted)" id="lore-count">(0)</span>
        </div>
        <div class="feed" id="lore-feed">
          <div class="empty-state">Waiting for signals...</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9"/></svg>
            LORE config
          </div>
        </div>
        <div class="kv-list" id="lore-config">
          <div style="color:var(--muted);font-size:.78rem">Loading...</div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const $ = s => document.querySelector(s);
const BASE = location.origin;
let startedAt = Date.now();

async function api(path) {
  try { const r = await fetch(BASE + path); return await r.json(); } catch { return null; }
}

function duration(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function pnlClass(v) { return v > 0 ? 'pnl-pos' : v < 0 ? 'pnl-neg' : 'pnl-zero'; }
function pnlStr(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function solStr(v) { return v != null ? parseFloat(v).toFixed(4) : '--'; }
function usdStr(v) { return v != null ? '$' + parseFloat(v).toFixed(6) : '--'; }
function shortMint(m) { return m ? m.slice(0, 4) + '...' + m.slice(-4) : '--'; }

function copyAddr() {
  const addr = $('#wallet-addr').textContent;
  if (addr && addr !== '--') navigator.clipboard.writeText(addr);
  const b = $('#copy-btn'); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200);
}

// ─── Wallet ──────────────────────────────
async function loadWallet() {
  const w = await api('/snipe/wallet');
  if (!w) return;
  const dotEl = $('#wallet-dot');
  const statusEl = $('#wallet-status');
  if (w.ready) {
    dotEl.innerHTML = '<span class="dot dot-ok"></span>';
    statusEl.textContent = 'Online';
    statusEl.style.color = 'var(--green)';
  } else {
    dotEl.innerHTML = '<span class="dot dot-off"></span>';
    statusEl.textContent = 'Not ready';
    statusEl.style.color = 'var(--red)';
  }
  $('#wallet-addr').textContent = w.walletAddress || '--';
  $('#sol-balance').textContent = w.solBalance != null ? parseFloat(w.solBalance).toFixed(4) + ' SOL' : '-- SOL';
}

// ─── Stats ──────────────────────────────
async function loadStats() {
  const p = await api('/snipe/portfolio');
  if (!p) return;
  $('#stat-open').textContent = p.openPositions ? p.openPositions.length : 0;
  $('#stat-trades').textContent = p.totalTrades || 0;
  const pnl = p.totalRealizedPnlSol || 0;
  const pnlEl = $('#stat-pnl');
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(4);
  pnlEl.style.color = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : '#fff';
}

// ─── Positions ──────────────────────────
async function loadPositions() {
  const p = await api('/snipe/portfolio');
  const body = $('#positions-body');
  if (!p || !p.openPositions || p.openPositions.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No open positions</td></tr>';
    return;
  }
  body.innerHTML = p.openPositions.map(function(pos) {
    const symbol = pos.symbol || shortMint(pos.mintAddress);
    const solIn = solStr(pos.totalSolSpent);
    const entry = usdStr(pos.entryPriceUsd);
    const current = usdStr(pos.currentPriceUsd);
    const change = pos.changePct != null ? pos.changePct : 0;
    const dur = duration(pos.firstTradeAt);
    const statusBadge = pos.isMoonBag ? '<span class="badge badge-moon">Moon bag</span>' : '<span class="badge badge-open">Open</span>';
    return '<tr>' +
      '<td><div class="token-name">' + symbol + '</div><div class="token-mint">' + shortMint(pos.mintAddress) + '</div></td>' +
      '<td style="font-family:var(--mono)">' + solIn + '</td>' +
      '<td style="font-family:var(--mono)">' + entry + '</td>' +
      '<td style="font-family:var(--mono)">' + current + '</td>' +
      '<td><span class="' + pnlClass(change) + '">' + pnlStr(change) + '</span></td>' +
      '<td style="font-family:var(--mono);color:var(--muted)">' + dur + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '</tr>';
  }).join('');
}

// ─── LORE config ────────────────────────
async function loadLoreConfig() {
  const st = await api('/lore/status');
  const el = $('#lore-config');
  if (!st) { el.innerHTML = '<div style="color:var(--muted)">Unavailable</div>'; return; }
  el.innerHTML =
    '<div class="kv"><span class="k">Webhook</span><span class="v" style="color:' + (st.webhookConfigured ? 'var(--green)' : 'var(--red)') + '">' + (st.webhookConfigured ? 'Connected' : 'Not set') + '</span></div>' +
    '<div class="kv"><span class="k">Auto-trade</span><span class="v" style="color:' + (st.autoTradeEnabled ? 'var(--green)' : 'var(--muted)') + '">' + (st.autoTradeEnabled ? 'Enabled' : 'Disabled') + '</span></div>' +
    '<div class="kv"><span class="k">Box types</span><span class="v">' + (st.autoTradeBoxTypes && st.autoTradeBoxTypes.length ? st.autoTradeBoxTypes.join(', ') : '--') + '</span></div>' +
    '<div class="kv"><span class="k">Amount per trade</span><span class="v">' + (st.autoTradeAmountSol || 0) + ' SOL</span></div>';
}

// ─── Uptime ─────────────────────────────
async function loadUptime() {
  const h = await api('/health');
  if (!h) return;
  const el = $('#sidebar-uptime');
  if (h.uptimeSeconds != null) {
    const s = h.uptimeSeconds;
    if (s < 60) el.textContent = s + 's';
    else if (s < 3600) el.textContent = Math.floor(s / 60) + 'm';
    else if (s < 86400) el.textContent = Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    else el.textContent = Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
}

// ─── Load all ────────────────────────────
function loadAll() {
  loadWallet();
  loadStats();
  loadPositions();
  loadLoreConfig();
  loadUptime();
}
loadAll();
setInterval(loadAll, 10000);

// ─── WebSocket: LORE live feed ──────────
(function initWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let loreCount = 0;
  const eventColors = {
    'token_featured': 'event-featured',
    'token_moved': 'event-moved',
    'token_reentry': 'event-reentry',
    'token_removed': 'event-removed',
    'candidates_updated': 'event-candidates',
  };

  function connect() {
    let ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/ws'); } catch { return; }

    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'lore.signal') return;

        loreCount++;
        const feed = $('#lore-feed');
        if (loreCount === 1) feed.innerHTML = '';

        const d = msg.data || {};
        const event = d.event || '?';
        const token = (d.data && d.data.token) ? (d.data.token.symbol || shortMint(d.data.token.address)) : '?';
        const box = (d.data && d.data.boxType) ? d.data.boxType : '';
        const cls = eventColors[event] || 'event-unknown';
        const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '';

        const item = document.createElement('div');
        item.className = 'feed-item';
        item.innerHTML =
          '<span class="feed-time">' + time + '</span>' +
          '<span class="feed-event ' + cls + '">' + event + '</span>' +
          '<span class="feed-detail">' + token + (box ? ' &middot; ' + box : '') + '</span>';
        feed.insertBefore(item, feed.firstChild);
        while (feed.children.length > 30) feed.removeChild(feed.lastChild);

        $('#lore-count').textContent = '(' + loreCount + ')';
      } catch {}
    };

    ws.onclose = function() { setTimeout(connect, 3000); };
    ws.onerror = function() { ws.close(); };
  }

  connect();
})();
</script>
</body>
</html>`;
}
