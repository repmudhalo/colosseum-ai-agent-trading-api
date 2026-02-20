import { dashboardShell } from './dashboardLayout.js';

export function renderExperimentPage(): string {
  return dashboardShell({
    title: 'Dashboard',
    activeNav: 'dashboard',
    bodyContent: `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Trading bot overview, live positions, and incoming LORE signals.</div>

    <div style="display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:1.5rem;flex-wrap:wrap" id="wallet-bar">
      <span id="wallet-dot"><span class="dot dot-off"></span></span>
      <span id="wallet-status" style="font-size:.78rem;font-weight:600">Connecting...</span>
      <span style="font-family:var(--mono);font-size:.82rem;color:var(--cyan);letter-spacing:.3px" id="wallet-addr">--</span>
      <button class="btn" id="copy-btn" onclick="copyAddr()">Copy</button>
      <span style="margin-left:auto;font-family:var(--mono);font-size:.82rem;font-weight:700;color:#fff" id="sol-balance">-- SOL</span>
    </div>

    <div class="grid-3" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>Open positions</div>
        <div class="stat-big" id="stat-open">--</div>
        <div class="stat-label">Currently held tokens</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Total trades</div>
        <div class="stat-big" id="stat-trades">--</div>
        <div class="stat-label">Buys + sells + auto-exits</div>
      </div>
      <div class="card">
        <div class="card-title"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Realized P&L</div>
        <div class="stat-big" id="stat-pnl">--</div>
        <div class="stat-label">SOL (closed positions)</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <div class="card-title"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>Active positions</div>
        <button class="btn" onclick="loadPositions()">Refresh</button>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Token</th><th>MCap</th><th>SOL in</th><th>Entry</th><th>Current</th><th>P&L</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody id="positions-body"><tr><td colspan="8" class="empty-state">Loading...</td></tr></tbody></table>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>LORE signals</div>
          <span style="font-size:.68rem;color:var(--muted)" id="lore-count">(0)</span>
        </div>
        <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:0" id="lore-feed">
          <div class="empty-state">Waiting for signals...</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9"/></svg>LORE config</div>
        </div>
        <div class="kv-list" id="lore-config"><div style="color:var(--muted);font-size:.78rem">Loading...</div></div>
      </div>
    </div>`,
    scripts: `
function copyAddr(){const a=$('#wallet-addr').textContent;if(a&&a!=='--')navigator.clipboard.writeText(a);const b=$('#copy-btn');b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200);}
async function loadWallet(){const w=await api('/snipe/wallet');if(!w)return;$('#wallet-dot').innerHTML=w.ready?'<span class="dot dot-ok"></span>':'<span class="dot dot-off"></span>';const s=$('#wallet-status');s.textContent=w.ready?'Online':'Not ready';s.style.color=w.ready?'var(--green)':'var(--red)';$('#wallet-addr').textContent=w.walletAddress||'--';$('#sol-balance').textContent=w.solBalance!=null?parseFloat(w.solBalance).toFixed(4)+' SOL':'-- SOL';}
async function loadStats(){const p=await api('/snipe/portfolio');if(!p)return;$('#stat-open').textContent=p.openPositions?p.openPositions.length:0;$('#stat-trades').textContent=p.totalTrades||0;const pnl=p.totalRealizedPnlSol||0;const el=$('#stat-pnl');el.textContent=(pnl>=0?'+':'')+pnl.toFixed(4);el.style.color=pnl>0?'var(--green)':pnl<0?'var(--red)':'#fff';}
function mcapStr(v){if(v==null)return'--';if(v>=1e9)return'$'+(v/1e9).toFixed(2)+'B';if(v>=1e6)return'$'+(v/1e6).toFixed(2)+'M';if(v>=1e3)return'$'+(v/1e3).toFixed(1)+'K';return'$'+Math.round(v);}
async function loadPositions(){const p=await api('/snipe/portfolio');const body=$('#positions-body');if(!p||!p.openPositions||!p.openPositions.length){body.innerHTML='<tr><td colspan="8" class="empty-state">No open positions</td></tr>';return;}body.innerHTML=p.openPositions.map(function(pos){const sym=pos.symbol||shortMint(pos.mintAddress);const change=pos.changePct!=null?pos.changePct:0;const st=pos.isMoonBag?'<span class="badge badge-moon">Moon bag</span>':'<span class="badge badge-open">Open</span>';const mc=mcapStr(pos.marketCapUsd);return '<tr><td><div class="token-name">'+sym+'</div><div class="token-mint">'+shortMint(pos.mintAddress)+'</div></td><td style="font-family:var(--mono);font-size:.75rem">'+mc+'</td><td style="font-family:var(--mono)">'+solStr(pos.totalSolSpent)+'</td><td style="font-family:var(--mono)">'+usdStr(pos.entryPriceUsd)+'</td><td style="font-family:var(--mono)">'+usdStr(pos.currentPriceUsd)+'</td><td><span class="'+pnlClass(change)+'">'+pnlStr(change)+'</span></td><td style="font-family:var(--mono);color:var(--muted)">'+duration(pos.firstTradeAt)+'</td><td>'+st+'</td></tr>';}).join('');}
async function loadLoreConfig(){const st=await api('/lore/status');const el=$('#lore-config');if(!st){el.innerHTML='<div style="color:var(--muted)">Unavailable</div>';return;}el.innerHTML='<div class="kv"><span class="k">Webhook</span><span class="v" style="color:'+(st.webhookConfigured?'var(--green)':'var(--red)')+'">'+(st.webhookConfigured?'Connected':'Not set')+'</span></div><div class="kv"><span class="k">Auto-trade</span><span class="v" style="color:'+(st.autoTradeEnabled?'var(--green)':'var(--muted)')+'">'+(st.autoTradeEnabled?'Enabled':'Disabled')+'</span></div><div class="kv"><span class="k">Box types</span><span class="v">'+(st.autoTradeBoxTypes&&st.autoTradeBoxTypes.length?st.autoTradeBoxTypes.join(', '):'--')+'</span></div><div class="kv"><span class="k">Amount/trade</span><span class="v">'+(st.autoTradeAmountSol||0)+' SOL</span></div>';}
function loadAll(){loadWallet();loadStats();loadPositions();loadLoreConfig();}
loadAll();setInterval(loadAll,10000);
(function(){const proto=location.protocol==='https:'?'wss:':'ws:';let n=0;const cls={'token_featured':'event-featured','token_moved':'event-moved','token_reentry':'event-reentry','token_removed':'event-removed','candidates_updated':'event-candidates'};function go(){let ws;try{ws=new WebSocket(proto+'//'+location.host+'/ws');}catch{return;}ws.onmessage=function(e){try{const m=JSON.parse(e.data);if(m.type!=='lore.signal')return;n++;const f=$('#lore-feed');if(n===1)f.innerHTML='';const d=m.data||{};const ev=d.event||'?';const tok=(d.data&&d.data.token)?(d.data.token.symbol||shortMint(d.data.token.address)):'?';const box=(d.data&&d.data.boxType)?d.data.boxType:'';const c=cls[ev]||'event-unknown';const t=m.ts?new Date(m.ts).toLocaleTimeString():'';const el=document.createElement('div');el.style.cssText='display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:.78rem';el.innerHTML='<span style="font-family:var(--mono);font-size:.68rem;color:var(--muted);white-space:nowrap;min-width:62px">'+t+'</span><span class="'+c+'" style="font-weight:600;min-width:110px">'+ev+'</span><span style="color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+tok+(box?' &middot; '+box:'')+'</span>';f.insertBefore(el,f.firstChild);while(f.children.length>30)f.removeChild(f.lastChild);$('#lore-count').textContent='('+n+')';}catch{}};ws.onclose=function(){setTimeout(go,3000);};ws.onerror=function(){ws.close();};}go();})();
`,
  });
}
