import { dashboardShell } from './dashboardLayout.js';

export function renderExperimentPage(): string {
  return dashboardShell({
    title: 'Dashboard',
    activeNav: 'dashboard',
    bodyContent: `
    <div class="page-title">Dashboard</div>
    <div class="page-sub">Trading bot overview, live positions, and incoming LORE signals.</div>

    <div style="display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:1.5rem;flex-wrap:wrap" id="wallet-bar">
      <select id="bot-select" style="background:var(--bg);border:1px solid var(--border);color:var(--accent);padding:6px 10px;border-radius:6px;font-size:.78rem;font-family:var(--sans);cursor:pointer;min-width:140px" onchange="switchBot()">
        <option value="">Loading bots...</option>
      </select>
      <button class="btn btn-accent" onclick="openAddBot()" title="Add a new bot">
        <svg viewBox="0 0 24 24" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.5;vertical-align:-1px;margin-right:4px"><path d="M12 5v14M5 12h14"/></svg>Add Bot
      </button>
      <span id="wallet-dot"><span class="dot dot-off"></span></span>
      <span id="wallet-status" style="font-size:.78rem;font-weight:600">Connecting...</span>
      <span style="font-family:var(--mono);font-size:.82rem;color:var(--cyan);letter-spacing:.3px" id="wallet-addr">--</span>
      <button class="btn" id="copy-btn" onclick="copyAddr()">Copy</button>
      <span style="margin-left:auto;font-family:var(--mono);font-size:.82rem;font-weight:700;color:#fff" id="sol-balance">-- SOL</span>
    </div>

    <!-- Add Bot Modal -->
    <div id="add-bot-modal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);align-items:center;justify-content:center">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:2rem;width:100%;max-width:460px;box-shadow:0 20px 50px rgba(0,0,0,.5)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
          <div style="font-size:1.1rem;font-weight:700;color:#fff">Add New Bot</div>
          <button onclick="closeAddBot()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem;padding:4px">&times;</button>
        </div>
        <form id="add-bot-form" onsubmit="submitAddBot(event)">
          <div class="form-group">
            <label>Bot ID (lowercase, no spaces)</label>
            <input type="text" id="ab-id" placeholder="e.g. aggressive" pattern="[a-zA-Z0-9_-]+" required/>
          </div>
          <div class="form-group">
            <label>Bot Name</label>
            <input type="text" id="ab-name" placeholder="e.g. Aggressive Scalper" required/>
          </div>
          <div class="form-group">
            <label>Wallet Private Key (Base58)</label>
            <input type="password" id="ab-key" placeholder="Base58 encoded private key" required style="font-family:var(--mono);font-size:.75rem"/>
          </div>
          <div class="form-group">
            <label>Strategy Preset</label>
            <select id="ab-preset" onchange="loadBotPreset()" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;font-size:.82rem;font-family:var(--sans);width:100%;cursor:pointer">
              <option value="">Custom (manual)</option>
            </select>
          </div>
          <div id="ab-strategy-fields">
            <div class="form-row">
              <div class="form-group">
                <label>Take Profit %</label>
                <input type="number" id="ab-tp" placeholder="30" step="1" min="1"/>
              </div>
              <div class="form-group">
                <label>Stop Loss %</label>
                <input type="number" id="ab-sl" placeholder="15" step="1" min="1"/>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Trailing Stop %</label>
                <input type="number" id="ab-trail" placeholder="20" step="1" min="1"/>
              </div>
              <div class="form-group">
                <label>Moon Bag %</label>
                <input type="number" id="ab-moon" placeholder="20" step="1" min="0" max="90"/>
              </div>
            </div>
          </div>
          <div id="ab-msg" class="msg" style="margin-bottom:1rem"></div>
          <div style="display:flex;gap:.75rem;justify-content:flex-end">
            <button type="button" class="btn" onclick="closeAddBot()">Cancel</button>
            <button type="submit" class="btn btn-accent" id="ab-submit">Create Bot</button>
          </div>
        </form>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:1.5rem">
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
        <div class="card-title"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Unrealized P&L</div>
        <div class="stat-big" id="stat-upnl">--</div>
        <div class="stat-label">SOL (open positions)</div>
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
        <button class="btn" onclick="loadAll()">Refresh</button>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Token</th><th>MCap</th><th>SOL in</th><th>Entry</th><th>Current</th><th>Change</th><th>P&L (SOL)</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody id="positions-body"><tr><td colspan="9" class="empty-state">Loading...</td></tr></tbody></table>
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
var currentBot='';
function botParam(){return currentBot?'?bot='+encodeURIComponent(currentBot):'';}
function botApi(path){return api(path+(path.includes('?')?'&':'?')+'bot='+encodeURIComponent(currentBot));}

var abPresets=[];
async function openAddBot(){
  $('#add-bot-modal').style.display='flex';$('#ab-id').focus();
  var res=await api('/strategy-presets');
  if(res&&res.presets){abPresets=res.presets;var sel=$('#ab-preset');sel.innerHTML='<option value="">Custom (manual)</option>'+abPresets.map(function(p){return '<option value="'+p.id+'">'+p.name+'</option>';}).join('');}
}
function loadBotPreset(){
  var id=$('#ab-preset').value;
  var fields=$('#ab-strategy-fields');
  if(!id){fields.style.opacity='1';fields.style.pointerEvents='auto';$('#ab-tp').value='';$('#ab-sl').value='';$('#ab-trail').value='';$('#ab-moon').value='';return;}
  var p=abPresets.find(function(x){return x.id===id;});
  if(!p)return;
  var s=p.strategy||{};
  $('#ab-tp').value=s.takeProfitPct!=null?s.takeProfitPct:'';
  $('#ab-sl').value=s.stopLossPct!=null?s.stopLossPct:'';
  $('#ab-trail').value=s.trailingStopPct!=null?s.trailingStopPct:'';
  $('#ab-moon').value=s.moonBagPct!=null?s.moonBagPct:'';
  fields.style.opacity='.5';fields.style.pointerEvents='none';
}
function closeAddBot(){$('#add-bot-modal').style.display='none';$('#add-bot-form').reset();$('#ab-msg').style.display='none';$('#ab-strategy-fields').style.opacity='1';$('#ab-strategy-fields').style.pointerEvents='auto';}
async function submitAddBot(e){
  e.preventDefault();
  var msg=$('#ab-msg');msg.style.display='none';
  var body={id:$('#ab-id').value.trim(),name:$('#ab-name').value.trim(),privateKeyB58:$('#ab-key').value.trim(),enabled:true};
  if(!body.id||!body.name||!body.privateKeyB58){msg.className='msg msg-err';msg.textContent='All fields are required.';msg.style.display='block';return;}
  var strategy={};
  var tp=$('#ab-tp').value;if(tp)strategy.takeProfitPct=Number(tp);
  var sl=$('#ab-sl').value;if(sl)strategy.stopLossPct=Number(sl);
  var tr=$('#ab-trail').value;if(tr)strategy.trailingStopPct=Number(tr);
  var mb=$('#ab-moon').value;if(mb!=='')strategy.moonBagPct=Number(mb);
  if(Object.keys(strategy).length>0)body.strategy=strategy;
  $('#ab-submit').disabled=true;$('#ab-submit').textContent='Creating...';
  try{
    var res=await fetch(BASE+'/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var data=await res.json();
    if(res.ok){
      msg.className='msg msg-ok';msg.textContent='Bot "'+data.name+'" created.';msg.style.display='block';
      await loadBots();currentBot=body.id;$('#bot-select').value=currentBot;
      setTimeout(function(){closeAddBot();loadAll();},1200);
    }else{
      msg.className='msg msg-err';msg.textContent=data.error||'Failed to create bot.';msg.style.display='block';
    }
  }catch(err){msg.className='msg msg-err';msg.textContent='Network error.';msg.style.display='block';}
  $('#ab-submit').disabled=false;$('#ab-submit').textContent='Create Bot';
}

function copyAddr(){const a=$('#wallet-addr').textContent;if(a&&a!=='--')navigator.clipboard.writeText(a);const b=$('#copy-btn');b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200);}
function mcapStr(v){if(v==null)return'--';if(v>=1e9)return'$'+(v/1e9).toFixed(2)+'B';if(v>=1e6)return'$'+(v/1e6).toFixed(2)+'M';if(v>=1e3)return'$'+(v/1e3).toFixed(1)+'K';return'$'+Math.round(v);}
function solPnl(v){if(v==null)return'--';return (v>=0?'+':'')+v.toFixed(4);}
function solPnlClass(v){if(v==null)return'pnl-zero';return v>0.0001?'pnl-pos':v<-0.0001?'pnl-neg':'pnl-zero';}
function setPnlStat(id,val){var el=$(id);if(val==null){el.textContent='--';el.style.color='#fff';return;}el.textContent=(val>=0?'+':'')+val.toFixed(4);el.style.color=val>0.0001?'var(--green)':val<-0.0001?'var(--red)':'#fff';}

async function loadBots(){
  var res=await api('/bots');
  if(!res||!res.bots)return;
  var sel=$('#bot-select');
  sel.innerHTML=res.bots.map(function(b){
    var label=b.name+(b.ready?'':' (offline)');
    return '<option value="'+b.id+'"'+(b.id===currentBot?' selected':'')+'>'+label+'</option>';
  }).join('');
  if(!currentBot&&res.bots.length>0){currentBot=res.bots[0].id;}
}
function switchBot(){currentBot=$('#bot-select').value;loadAll();}

async function loadAll(){
  var [w,p,st]=await Promise.all([botApi('/snipe/wallet'),botApi('/snipe/portfolio'),api('/lore/status')]);

  // Wallet bar
  if(w){$('#wallet-dot').innerHTML=w.ready?'<span class="dot dot-ok"></span>':'<span class="dot dot-off"></span>';var s=$('#wallet-status');s.textContent=w.ready?'Online':'Not ready';s.style.color=w.ready?'var(--green)':'var(--red)';$('#wallet-addr').textContent=w.walletAddress||'--';$('#sol-balance').textContent=w.solBalance!=null?parseFloat(w.solBalance).toFixed(4)+' SOL':'-- SOL';}

  // Stats
  if(p){$('#stat-open').textContent=p.openPositions?p.openPositions.length:0;$('#stat-trades').textContent=p.totalTrades||0;setPnlStat('#stat-upnl',p.totalUnrealizedPnlSol);setPnlStat('#stat-pnl',p.totalRealizedPnlSol);}

  // Active positions table
  var body=$('#positions-body');
  if(!p||!p.openPositions||!p.openPositions.length){body.innerHTML='<tr><td colspan="9" class="empty-state">No open positions</td></tr>';}else{body.innerHTML=p.openPositions.map(function(pos){var sym=pos.symbol||shortMint(pos.mintAddress);var change=pos.changePct!=null?pos.changePct:0;var uPnl=pos.unrealizedPnlSol;var st=pos.isMoonBag?'<span class="badge badge-moon">Moon bag</span>':'<span class="badge badge-open">Open</span>';var mc=mcapStr(pos.marketCapUsd);return '<tr><td><div class="token-name">'+sym+'</div><div class="token-mint">'+shortMint(pos.mintAddress)+'</div></td><td style="font-family:var(--mono);font-size:.75rem">'+mc+'</td><td style="font-family:var(--mono)">'+solStr(pos.totalSolSpent)+'</td><td style="font-family:var(--mono)">'+usdStr(pos.entryPriceUsd)+'</td><td style="font-family:var(--mono)">'+usdStr(pos.currentPriceUsd)+'</td><td><span class="'+pnlClass(change)+'">'+pnlStr(change)+'</span></td><td><span class="'+solPnlClass(uPnl)+'">'+solPnl(uPnl)+'</span></td><td style="font-family:var(--mono);color:var(--muted)">'+duration(pos.firstTradeAt)+'</td><td>'+st+'</td></tr>';}).join('');}

  // LORE config
  var el=$('#lore-config');if(!st){el.innerHTML='<div style="color:var(--muted)">Unavailable</div>';}else{el.innerHTML='<div class="kv"><span class="k">Webhook</span><span class="v" style="color:'+(st.webhookConfigured?'var(--green)':'var(--red)')+'">'+(st.webhookConfigured?'Connected':'Not set')+'</span></div><div class="kv"><span class="k">Auto-trade</span><span class="v" style="color:'+(st.autoTradeEnabled?'var(--green)':'var(--muted)')+'">'+(st.autoTradeEnabled?'Enabled':'Disabled')+'</span></div><div class="kv"><span class="k">Box types</span><span class="v">'+(st.autoTradeBoxTypes&&st.autoTradeBoxTypes.length?st.autoTradeBoxTypes.join(', '):'--')+'</span></div><div class="kv"><span class="k">Amount/trade</span><span class="v">'+(st.autoTradeAmountSol||0)+' SOL</span></div>';}
}
loadBots().then(loadAll);setInterval(loadAll,10000);setInterval(loadBots,30000);
(function(){const proto=location.protocol==='https:'?'wss:':'ws:';let n=0;const cls={'token_featured':'event-featured','token_moved':'event-moved','token_reentry':'event-reentry','token_removed':'event-removed','candidates_updated':'event-candidates'};function go(){let ws;try{ws=new WebSocket(proto+'//'+location.host+'/ws');}catch{return;}ws.onmessage=function(e){try{const m=JSON.parse(e.data);if(m.type!=='lore.signal')return;n++;const f=$('#lore-feed');if(n===1)f.innerHTML='';const d=m.data||{};const ev=d.event||'?';const tok=(d.data&&d.data.token)?(d.data.token.symbol||shortMint(d.data.token.address)):'?';const box=(d.data&&d.data.boxType)?d.data.boxType:'';const c=cls[ev]||'event-unknown';const t=m.ts?new Date(m.ts).toLocaleTimeString():'';const el=document.createElement('div');el.style.cssText='display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:.78rem';el.innerHTML='<span style="font-family:var(--mono);font-size:.68rem;color:var(--muted);white-space:nowrap;min-width:62px">'+t+'</span><span class="'+c+'" style="font-weight:600;min-width:110px">'+ev+'</span><span style="color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+tok+(box?' &middot; '+box:'')+'</span>';f.insertBefore(el,f.firstChild);while(f.children.length>30)f.removeChild(f.lastChild);$('#lore-count').textContent='('+n+')';}catch{}};ws.onclose=function(){setTimeout(go,3000);};ws.onerror=function(){ws.close();};}go();})();
`,
  });
}
