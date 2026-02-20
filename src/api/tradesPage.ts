import { dashboardShell } from './dashboardLayout.js';

export function renderTradesPage(): string {
  return dashboardShell({
    title: 'Trade History',
    activeNav: 'trades',
    bodyContent: `
    <div class="page-title">Trade History</div>
    <div class="page-sub">Every buy, sell, auto-exit, and re-entry — newest first.</div>

    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          All trades
          <span id="trade-total" style="font-size:.68rem;color:var(--muted);margin-left:4px">(--)</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="filter-mint" placeholder="Filter by mint..." style="width:180px;padding:6px 10px;font-size:.75rem"/>
          <button class="btn" onclick="load()">Refresh</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Token</th>
              <th>Side</th>
              <th>SOL</th>
              <th>Tokens</th>
              <th>Tag</th>
              <th>TX</th>
            </tr>
          </thead>
          <tbody id="trades-body">
            <tr><td colspan="7" class="empty-state">Loading...</td></tr>
          </tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem">
        <button class="btn" id="btn-prev" onclick="prev()" disabled>Previous</button>
        <span style="font-size:.75rem;color:var(--muted)" id="page-info">Page 1</span>
        <button class="btn" id="btn-next" onclick="next()">Next</button>
      </div>
    </div>`,
    scripts: `
const PAGE_SIZE = 25;
let allTrades = [];
let page = 0;

function renderTable() {
  const body = $('#trades-body');
  const start = page * PAGE_SIZE;
  const slice = allTrades.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No trades</td></tr>';
  } else {
    body.innerHTML = slice.map(function(t) {
      const sym = t.symbol || shortMint(t.mintAddress);
      const isBuy = t.side === 'buy';
      const side = isBuy
        ? '<span class="badge badge-buy">Buy</span>'
        : '<span class="badge badge-sell">Sell</span>';
      const tag = t.autoExitReason
        ? '<span class="badge badge-auto">' + t.autoExitReason.substring(0, 20) + '</span>'
        : (t.tag ? '<span style="font-size:.72rem;color:var(--muted)">' + t.tag.substring(0, 20) + '</span>' : '<span style="color:var(--muted)">--</span>');
      const tx = t.txSignature
        ? '<a class="solscan-link" href="https://solscan.io/tx/' + t.txSignature + '" target="_blank" rel="noopener">' + t.txSignature.slice(0, 8) + '...</a>'
        : '<span style="font-size:.72rem;color:var(--muted)">simulated</span>';
      const time = t.timestamp ? new Date(t.timestamp).toLocaleString() : '--';
      const tokens = t.tokenAmount ? parseFloat(t.tokenAmount).toLocaleString() : '--';
      const sol = t.amountSol != null ? parseFloat(t.amountSol) : 0;
      const solDisplay = isBuy
        ? '<span style="color:var(--red)">-' + sol.toFixed(4) + '</span>'
        : '<span style="color:var(--green)">+' + sol.toFixed(4) + '</span>';
      return '<tr>' +
        '<td style="font-family:var(--mono);font-size:.72rem;color:var(--muted);white-space:nowrap">' + time + '</td>' +
        '<td><div class="token-name">' + sym + '</div><div class="token-mint">' + shortMint(t.mintAddress) + '</div></td>' +
        '<td>' + side + '</td>' +
        '<td style="font-family:var(--mono)">' + solDisplay + '</td>' +
        '<td style="font-family:var(--mono);font-size:.72rem">' + tokens + '</td>' +
        '<td>' + tag + '</td>' +
        '<td>' + tx + '</td></tr>';
    }).join('');
  }

  const totalPages = Math.max(1, Math.ceil(allTrades.length / PAGE_SIZE));
  $('#page-info').textContent = 'Page ' + (page + 1) + ' of ' + totalPages;
  $('#btn-prev').disabled = page === 0;
  $('#btn-next').disabled = start + PAGE_SIZE >= allTrades.length;
}

function prev() { if (page > 0) { page--; renderTable(); } }
function next() { if ((page + 1) * PAGE_SIZE < allTrades.length) { page++; renderTable(); } }

function getBot(){try{var p=new URLSearchParams(location.search);return p.get('bot')||'';}catch{return '';}}
var currentBot=getBot();
function botApi(path){return api(path+(path.includes('?')?'&':'?')+'bot='+encodeURIComponent(currentBot));}

async function load() {
  const mint = ($('#filter-mint').value || '').trim() || undefined;
  const url = '/snipe/trades?limit=200' + (mint ? '&mint=' + encodeURIComponent(mint) : '');
  const res = await botApi(url);
  allTrades = (res && res.trades) ? res.trades : [];
  page = 0;
  $('#trade-total').textContent = '(' + allTrades.length + ')';
  renderTable();
}

$('#filter-mint').addEventListener('keydown', function(e) { if (e.key === 'Enter') load(); });
load();
setInterval(load, 15000);
`,
  });
}
