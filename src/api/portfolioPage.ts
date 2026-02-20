import { dashboardShell } from './dashboardLayout.js';

export function renderPortfolioPage(): string {
  return dashboardShell({
    title: 'Portfolio',
    activeNav: 'portfolio',
    bodyContent: `
    <div class="page-title">Portfolio</div>
    <div class="page-sub">All positions — open, closed, and tokens watched for dip re-entry.</div>

    <div class="grid-4" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>Open</div>
        <div class="stat-big" id="s-open">--</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Closed</div>
        <div class="stat-big" id="s-closed">--</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Watched</div>
        <div class="stat-big" id="s-watched">--</div>
        <div class="stat-label">Re-entry watch</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Unrealized P&L</div>
        <div class="stat-big" id="s-upnl">--</div>
        <div class="stat-label">Open positions (SOL)</div>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Realized P&L</div>
        <div class="stat-big" id="s-rpnl">--</div>
        <div class="stat-label">Closed positions (SOL)</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Total SOL flow</div>
        <div class="stat-big" id="s-flow">--</div>
        <div class="stat-label">Spent / Received</div>
      </div>
    </div>

    <div class="tab-bar">
      <div class="tab active" id="tab-open" onclick="showTab('open')">Open</div>
      <div class="tab" id="tab-closed" onclick="showTab('closed')">Closed</div>
      <div class="tab" id="tab-watched" onclick="showTab('watched')">Watched</div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title" id="table-title">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          Open positions
        </div>
        <button class="btn" onclick="load()">Refresh</button>
      </div>
      <div class="table-wrap" id="table-container">
        <div class="empty-state">Loading...</div>
      </div>
    </div>`,
    scripts: `
function mcapStr(v) {
  if (v == null) return '--';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}
function solPnl(v){if(v==null)return'--';return (v>=0?'+':'')+v.toFixed(4);}
function solPnlClass(v){if(v==null)return'pnl-zero';return v>0.0001?'pnl-pos':v<-0.0001?'pnl-neg':'pnl-zero';}
function setPnlStat(id,val){var el=$(id);if(val==null){el.textContent='--';el.style.color='#fff';return;}el.textContent=(val>=0?'+':'')+val.toFixed(4);el.style.color=val>0.0001?'var(--green)':val<-0.0001?'var(--red)':'#fff';}

let portfolio = null;
let currentTab = 'open';

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('#tab-' + tab).classList.add('active');
  render();
}

function render() {
  const c = $('#table-container');
  const t = $('#table-title');
  if (!portfolio) { c.innerHTML = '<div class="empty-state">Loading...</div>'; return; }

  if (currentTab === 'open') {
    t.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>Open positions';
    const rows = portfolio.openPositions || [];
    if (!rows.length) { c.innerHTML = '<div class="empty-state">No open positions</div>'; return; }
    c.innerHTML = '<table><thead><tr><th>Token</th><th>MCap</th><th>SOL in</th><th>Entry</th><th>Current</th><th>Change</th><th>P&L (SOL)</th><th>From peak</th><th>Duration</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function(p) {
        const sym = p.symbol || shortMint(p.mintAddress);
        const change = p.changePct != null ? p.changePct : 0;
        const peak = p.changeFromPeakPct != null ? p.changeFromPeakPct : 0;
        const uPnl = p.unrealizedPnlSol;
        const st = p.isMoonBag ? '<span class="badge badge-moon">Moon</span>' : '<span class="badge badge-open">Open</span>';
        const mcap = p.marketCapUsd != null ? mcapStr(p.marketCapUsd) : '--';
        return '<tr>' +
          '<td><div class="token-name">' + sym + '</div><div class="token-mint">' + shortMint(p.mintAddress) + '</div></td>' +
          '<td style="font-family:var(--mono);font-size:.75rem">' + mcap + '</td>' +
          '<td style="font-family:var(--mono)">' + solStr(p.totalSolSpent) + '</td>' +
          '<td style="font-family:var(--mono)">' + usdStr(p.entryPriceUsd) + '</td>' +
          '<td style="font-family:var(--mono)">' + usdStr(p.currentPriceUsd) + '</td>' +
          '<td><span class="' + pnlClass(change) + '">' + pnlStr(change) + '</span></td>' +
          '<td><span class="' + solPnlClass(uPnl) + '">' + solPnl(uPnl) + '</span></td>' +
          '<td><span class="' + pnlClass(peak) + '">' + pnlStr(peak) + '</span></td>' +
          '<td style="font-family:var(--mono);color:var(--muted)">' + duration(p.firstTradeAt) + '</td>' +
          '<td>' + st + '</td></tr>';
      }).join('') + '</tbody></table>';

  } else if (currentTab === 'closed') {
    t.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Closed positions';
    const rows = portfolio.closedPositions || [];
    if (!rows.length) { c.innerHTML = '<div class="empty-state">No closed positions</div>'; return; }
    c.innerHTML = '<table><thead><tr><th>Token</th><th>SOL in</th><th>SOL out</th><th>P&L (SOL)</th><th>Exit reason</th><th>Duration</th></tr></thead><tbody>' +
      rows.map(function(p) {
        const sym = p.symbol || shortMint(p.mintAddress);
        const pnlVal = p.realizedPnlSol || 0;
        return '<tr>' +
          '<td><div class="token-name">' + sym + '</div><div class="token-mint">' + shortMint(p.mintAddress) + '</div></td>' +
          '<td style="font-family:var(--mono)">' + solStr(p.totalSolSpent) + '</td>' +
          '<td style="font-family:var(--mono)">' + solStr(p.totalSolReceived) + '</td>' +
          '<td><span class="' + solPnlClass(pnlVal) + '">' + solPnl(pnlVal) + '</span></td>' +
          '<td style="font-size:.72rem;color:var(--muted)">' + (p.autoExitReason || 'manual') + '</td>' +
          '<td style="font-family:var(--mono);color:var(--muted)">' + duration(p.firstTradeAt) + '</td></tr>';
      }).join('') + '</tbody></table>';

  } else {
    t.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Watched for re-entry';
    const rows = portfolio.watchedForReEntry || [];
    if (!rows.length) { c.innerHTML = '<div class="empty-state">No tokens being watched</div>'; return; }
    c.innerHTML = '<table><thead><tr><th>Token</th><th>Sell price</th><th>Re-entry below</th><th>Remaining</th></tr></thead><tbody>' +
      rows.map(function(w) {
        const sym = w.symbol || shortMint(w.mintAddress);
        return '<tr>' +
          '<td><div class="token-name">' + sym + '</div><div class="token-mint">' + shortMint(w.mintAddress) + '</div></td>' +
          '<td style="font-family:var(--mono)">' + usdStr(w.sellPriceUsd) + '</td>' +
          '<td style="font-family:var(--mono)">' + usdStr(w.reEntryBelow) + '</td>' +
          '<td style="font-family:var(--mono)">' + w.remainingReEntries + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
}

async function load() {
  portfolio = await api('/snipe/portfolio');
  if (portfolio) {
    $('#s-open').textContent = portfolio.openPositions ? portfolio.openPositions.length : 0;
    $('#s-closed').textContent = portfolio.closedPositions ? portfolio.closedPositions.length : 0;
    $('#s-watched').textContent = portfolio.watchedForReEntry ? portfolio.watchedForReEntry.length : 0;
    setPnlStat('#s-upnl', portfolio.totalUnrealizedPnlSol);
    setPnlStat('#s-rpnl', portfolio.totalRealizedPnlSol);
    var spent = portfolio.totalSolSpent || 0;
    var received = portfolio.totalSolReceived || 0;
    $('#s-flow').textContent = spent.toFixed(4) + ' / ' + received.toFixed(4);
    $('#s-flow').style.color = '#fff';
  }
  render();
}
load();
setInterval(load, 12000);
`,
  });
}
