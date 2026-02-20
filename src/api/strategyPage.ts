import { dashboardShell } from './dashboardLayout.js';

export function renderStrategyPage(): string {
  return dashboardShell({
    title: 'Strategy',
    activeNav: 'strategy',
    bodyContent: `
    <div class="page-title">Exit Strategy</div>
    <div class="page-sub">View and update the active exit strategy, or manage saved presets for reuse across bots.</div>

    <div class="grid-2" style="margin-bottom:1.5rem">
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83"/></svg>
            Current defaults
          </div>
          <button class="btn" onclick="load()">Refresh</button>
        </div>
        <div class="kv-list" id="strategy-view">
          <div style="color:var(--muted);font-size:.78rem">Loading...</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Update strategy
          </div>
          <div style="display:flex;gap:.5rem">
            <select id="preset-loader" onchange="loadPresetIntoForm()" style="background:var(--bg);border:1px solid var(--border);color:var(--accent);padding:4px 8px;border-radius:6px;font-size:.72rem;font-family:var(--sans);cursor:pointer;max-width:160px">
              <option value="">Load preset...</option>
            </select>
            <button class="btn" type="button" onclick="openSavePreset()" title="Save current form as preset">
              <svg viewBox="0 0 24 24" style="width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.5;vertical-align:-1px;margin-right:3px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save as preset
            </button>
          </div>
        </div>
        <form id="strategy-form" onsubmit="save(event)">
          <div class="form-row">
            <div class="form-group">
              <label for="f-tp">Take profit %</label>
              <input type="number" id="f-tp" step="1" min="1" max="10000" placeholder="30"/>
            </div>
            <div class="form-group">
              <label for="f-sl">Stop loss %</label>
              <input type="number" id="f-sl" step="1" min="1" max="100" placeholder="15"/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="f-trail">Trailing stop %</label>
              <input type="number" id="f-trail" step="1" min="1" max="100" placeholder="20"/>
            </div>
            <div class="form-group">
              <label for="f-moon">Moon bag %</label>
              <input type="number" id="f-moon" step="1" min="0" max="90" placeholder="20"/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="f-redip">Re-entry dip %</label>
              <input type="number" id="f-redip" step="1" min="1" max="100" placeholder="25"/>
            </div>
            <div class="form-group">
              <label for="f-resol">Re-entry SOL</label>
              <input type="number" id="f-resol" step="0.001" min="0.001" max="10" placeholder="0.01"/>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="f-maxre">Max re-entries</label>
              <input type="number" id="f-maxre" step="1" min="0" max="100" placeholder="2"/>
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end">
              <button type="submit" class="btn btn-accent" style="width:100%;padding:10px">Apply to bot</button>
            </div>
          </div>
        </form>
        <div class="msg msg-ok" id="msg-ok">Strategy updated.</div>
        <div class="msg msg-err" id="msg-err">--</div>
      </div>
    </div>

    <!-- Saved Presets Section -->
    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Saved strategy presets
        </div>
        <button class="btn btn-accent" onclick="openSavePreset()">
          <svg viewBox="0 0 24 24" style="width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.5;vertical-align:-1px;margin-right:3px"><path d="M12 5v14M5 12h14"/></svg>New preset
        </button>
      </div>
      <div id="presets-list"><div class="empty-state">Loading...</div></div>
    </div>

    <!-- Save Preset Modal -->
    <div id="save-preset-modal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);align-items:center;justify-content:center">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:2rem;width:100%;max-width:420px;box-shadow:0 20px 50px rgba(0,0,0,.5)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
          <div style="font-size:1.1rem;font-weight:700;color:#fff">Save Strategy Preset</div>
          <button onclick="closeSavePreset()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem;padding:4px">&times;</button>
        </div>
        <form id="save-preset-form" onsubmit="submitSavePreset(event)">
          <div class="form-group">
            <label>Preset ID (lowercase, no spaces)</label>
            <input type="text" id="sp-id" placeholder="e.g. aggressive-scalp" pattern="[a-zA-Z0-9_-]+" required/>
          </div>
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="sp-name" placeholder="e.g. Aggressive Scalper" required/>
          </div>
          <div class="form-group">
            <label>Description (optional)</label>
            <input type="text" id="sp-desc" placeholder="Short note about this strategy"/>
          </div>
          <div style="font-size:.72rem;color:var(--muted);margin-bottom:1rem;padding:8px 10px;background:var(--bg);border-radius:6px" id="sp-preview">Fill in the strategy form above first, or current defaults will be used.</div>
          <div id="sp-msg" class="msg" style="margin-bottom:1rem"></div>
          <div style="display:flex;gap:.75rem;justify-content:flex-end">
            <button type="button" class="btn" onclick="closeSavePreset()">Cancel</button>
            <button type="submit" class="btn btn-accent" id="sp-submit">Save Preset</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          How it works
        </div>
      </div>
      <div class="kv-list">
        <div class="kv"><span class="k">Take profit</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Dynamic range: TP-5% to TP+5%. Early exit within range if momentum fades.</span></div>
        <div class="kv"><span class="k">Stop loss</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Full sell when price drops SL% below entry.</span></div>
        <div class="kv"><span class="k">Trailing stop</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Full sell when price drops trail% from its peak.</span></div>
        <div class="kv"><span class="k">Moon bag</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">% of tokens kept after TP. Rides with trailing stop only.</span></div>
        <div class="kv"><span class="k">Re-entry</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">After TP, auto-buy back when price dips re-entry% from sell.</span></div>
        <div class="kv"><span class="k">Min market cap</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Force-close if mcap drops below this. Blocks new LORE trades too.</span></div>
        <div class="kv"><span class="k">Presets</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Save strategies as presets. Load them into any bot when creating or editing.</span></div>
      </div>
    </div>`,
    scripts: `
let strat = null;
let presets = [];
function getBot(){try{var p=new URLSearchParams(location.search);return p.get('bot')||'';}catch{return '';}}
var currentBot=getBot();
function botApi(path){return api(path+(path.includes('?')?'&':'?')+'bot='+encodeURIComponent(currentBot));}

function kvRow(label, val) {
  return '<div class="kv"><span class="k">' + label + '</span><span class="v">' + val + '</span></div>';
}

// ── Strategy form helpers ───────────────────────────────────────────

function getFormStrategy() {
  var s = {};
  var tp = $('#f-tp').value; if (tp) s.takeProfitPct = Number(tp);
  var sl = $('#f-sl').value; if (sl) s.stopLossPct = Number(sl);
  var tr = $('#f-trail').value; if (tr) s.trailingStopPct = Number(tr);
  var mb = $('#f-moon').value; if (mb !== '') s.moonBagPct = Number(mb);
  var rd = $('#f-redip').value; if (rd) s.reEntryDipPct = Number(rd);
  var rs = $('#f-resol').value; if (rs) s.reEntryAmountSol = Number(rs);
  var mr = $('#f-maxre').value; if (mr !== '') s.maxReEntries = Number(mr);
  return s;
}

function fillFormFromStrategy(s) {
  if (!s) return;
  if (s.takeProfitPct != null) $('#f-tp').value = s.takeProfitPct;
  if (s.stopLossPct != null) $('#f-sl').value = s.stopLossPct;
  if (s.trailingStopPct != null) $('#f-trail').value = s.trailingStopPct;
  if (s.moonBagPct != null) $('#f-moon').value = s.moonBagPct;
  if (s.reEntryDipPct != null) $('#f-redip').value = s.reEntryDipPct;
  if (s.reEntryAmountSol != null) $('#f-resol').value = s.reEntryAmountSol;
  if (s.maxReEntries != null) $('#f-maxre').value = s.maxReEntries;
}

function stratSummary(s) {
  var parts = [];
  if (s.takeProfitPct != null) parts.push('TP ' + s.takeProfitPct + '%');
  if (s.stopLossPct != null) parts.push('SL ' + s.stopLossPct + '%');
  if (s.trailingStopPct != null) parts.push('Trail ' + s.trailingStopPct + '%');
  if (s.moonBagPct != null) parts.push('Moon ' + s.moonBagPct + '%');
  if (s.reEntryDipPct != null) parts.push('Re-dip ' + s.reEntryDipPct + '%');
  return parts.length ? parts.join(' / ') : 'No params set';
}

// ── Load current bot strategy ───────────────────────────────────────

async function load() {
  var [res, presetsRes] = await Promise.all([botApi('/snipe/strategy'), api('/strategy-presets')]);
  if (res && res.defaultStrategy) {
    strat = res.defaultStrategy;
    var el = $('#strategy-view');
    var minMcap = res.minMarketCapUsd || 5000;
    el.innerHTML =
      kvRow('Take profit', strat.takeProfitPct + '% (range: ' + (strat.takeProfitPct - 5) + '-' + (strat.takeProfitPct + 5) + '%)') +
      kvRow('Stop loss', strat.stopLossPct + '%') +
      kvRow('Trailing stop', strat.trailingStopPct != null ? strat.trailingStopPct + '%' : 'Off') +
      kvRow('Moon bag', strat.moonBagPct + '%') +
      kvRow('Re-entry', strat.reEntryEnabled ? 'Enabled' : 'Disabled') +
      kvRow('Re-entry dip', strat.reEntryDipPct + '%') +
      kvRow('Re-entry SOL', strat.reEntryAmountSol) +
      kvRow('Max re-entries', strat.maxReEntries) +
      kvRow('Min market cap', '$' + minMcap.toLocaleString());

    $('#f-tp').placeholder = strat.takeProfitPct;
    $('#f-sl').placeholder = strat.stopLossPct;
    $('#f-trail').placeholder = strat.trailingStopPct != null ? strat.trailingStopPct : '--';
    $('#f-moon').placeholder = strat.moonBagPct;
    $('#f-redip').placeholder = strat.reEntryDipPct;
    $('#f-resol').placeholder = strat.reEntryAmountSol;
    $('#f-maxre').placeholder = strat.maxReEntries;
  }

  if (presetsRes && presetsRes.presets) {
    presets = presetsRes.presets;
    renderPresets();
    renderPresetDropdown();
  }
}

// ── Apply strategy to bot ────────────────────────────────────────────

async function save(e) {
  e.preventDefault();
  var body = getFormStrategy();
  if (!Object.keys(body).length) return;

  var res = await fetch(BASE + '/snipe/strategy' + (currentBot ? '?bot=' + encodeURIComponent(currentBot) : ''), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(r){return r.json();}).catch(function(){return null;});

  var ok = $('#msg-ok');
  var err = $('#msg-err');
  ok.style.display = 'none';
  err.style.display = 'none';

  if (res && res.defaultStrategy) {
    ok.style.display = 'block';
    setTimeout(function(){ok.style.display='none';}, 3000);
    $('#strategy-form').reset();
    load();
  } else {
    err.textContent = (res && res.error) ? res.error : 'Failed to save.';
    err.style.display = 'block';
    setTimeout(function(){err.style.display='none';}, 4000);
  }
}

// ── Presets dropdown (load into form) ────────────────────────────────

function renderPresetDropdown() {
  var sel = $('#preset-loader');
  sel.innerHTML = '<option value="">Load preset...</option>' +
    presets.map(function(p){return '<option value="'+p.id+'">'+p.name+'</option>';}).join('');
}

function loadPresetIntoForm() {
  var id = $('#preset-loader').value;
  if (!id) return;
  var p = presets.find(function(x){return x.id===id;});
  if (!p) return;
  $('#strategy-form').reset();
  fillFormFromStrategy(p.strategy);
  $('#preset-loader').value = '';
}

// ── Presets list ─────────────────────────────────────────────────────

function renderPresets() {
  var el = $('#presets-list');
  if (!presets.length) {
    el.innerHTML = '<div class="empty-state">No saved presets yet. Save your first strategy above.</div>';
    return;
  }
  el.innerHTML = '<table><thead><tr><th>Name</th><th>Description</th><th>Strategy</th><th>Created</th><th></th></tr></thead><tbody>' +
    presets.map(function(p) {
      var created = new Date(p.createdAt).toLocaleDateString();
      return '<tr>' +
        '<td style="font-weight:600;color:#fff">' + p.name + '</td>' +
        '<td style="color:var(--muted);font-size:.75rem">' + (p.description || '--') + '</td>' +
        '<td style="font-family:var(--mono);font-size:.72rem;color:var(--cyan)">' + stratSummary(p.strategy) + '</td>' +
        '<td style="font-family:var(--mono);font-size:.72rem;color:var(--muted)">' + created + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn" onclick="usePreset(\\'' + p.id + '\\')" style="margin-right:4px" title="Load into form">Use</button>' +
          '<button class="btn" onclick="deletePreset(\\'' + p.id + '\\')" title="Delete preset" style="color:var(--red);border-color:rgba(239,68,68,.3)">&times;</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table>';
}

function usePreset(id) {
  var p = presets.find(function(x){return x.id===id;});
  if (!p) return;
  $('#strategy-form').reset();
  fillFormFromStrategy(p.strategy);
  window.scrollTo({top:0,behavior:'smooth'});
}

async function deletePreset(id) {
  if (!confirm('Delete this preset?')) return;
  await fetch(BASE+'/strategy-presets/'+encodeURIComponent(id),{method:'DELETE'});
  load();
}

// ── Save preset modal ────────────────────────────────────────────────

function openSavePreset() {
  var s = getFormStrategy();
  if (Object.keys(s).length === 0 && strat) {
    s = {
      takeProfitPct: strat.takeProfitPct,
      stopLossPct: strat.stopLossPct,
      trailingStopPct: strat.trailingStopPct,
      moonBagPct: strat.moonBagPct,
      reEntryDipPct: strat.reEntryDipPct,
      reEntryAmountSol: strat.reEntryAmountSol,
      maxReEntries: strat.maxReEntries,
    };
  }
  $('#sp-preview').textContent = 'Strategy: ' + stratSummary(s);
  $('#save-preset-modal').style.display = 'flex';
  $('#sp-id').focus();
}

function closeSavePreset() {
  $('#save-preset-modal').style.display = 'none';
  $('#save-preset-form').reset();
  $('#sp-msg').style.display = 'none';
}

async function submitSavePreset(e) {
  e.preventDefault();
  var msg = $('#sp-msg'); msg.style.display = 'none';
  var s = getFormStrategy();
  if (Object.keys(s).length === 0 && strat) {
    s = {
      takeProfitPct: strat.takeProfitPct,
      stopLossPct: strat.stopLossPct,
      trailingStopPct: strat.trailingStopPct,
      moonBagPct: strat.moonBagPct,
      reEntryDipPct: strat.reEntryDipPct,
      reEntryAmountSol: strat.reEntryAmountSol,
      maxReEntries: strat.maxReEntries,
    };
  }
  var body = {
    id: $('#sp-id').value.trim(),
    name: $('#sp-name').value.trim(),
    description: $('#sp-desc').value.trim() || undefined,
    strategy: s,
  };
  if (!body.id || !body.name) {
    msg.className='msg msg-err'; msg.textContent='ID and Name are required.'; msg.style.display='block';
    return;
  }

  $('#sp-submit').disabled = true; $('#sp-submit').textContent = 'Saving...';
  try {
    var res = await fetch(BASE+'/strategy-presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var data = await res.json();
    if (res.ok) {
      msg.className='msg msg-ok'; msg.textContent='Preset "'+data.name+'" saved.'; msg.style.display='block';
      await load();
      setTimeout(closeSavePreset, 1200);
    } else {
      msg.className='msg msg-err'; msg.textContent=data.error||'Failed.'; msg.style.display='block';
    }
  } catch(err) {
    msg.className='msg msg-err'; msg.textContent='Network error.'; msg.style.display='block';
  }
  $('#sp-submit').disabled = false; $('#sp-submit').textContent = 'Save Preset';
}

load();
`,
  });
}
