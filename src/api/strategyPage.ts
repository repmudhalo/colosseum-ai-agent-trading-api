import { dashboardShell } from './dashboardLayout.js';

export function renderStrategyPage(): string {
  return dashboardShell({
    title: 'Strategy',
    activeNav: 'strategy',
    bodyContent: `
    <div class="page-title">Exit Strategy</div>
    <div class="page-sub">View and update the default exit strategy applied to all future trades.</div>

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
              <button type="submit" class="btn btn-accent" style="width:100%;padding:10px">Save changes</button>
            </div>
          </div>
        </form>
        <div class="msg msg-ok" id="msg-ok">Strategy updated.</div>
        <div class="msg msg-err" id="msg-err">--</div>
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
        <div class="kv"><span class="k">Take profit</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Sell when price rises TP% above entry. Moon bag % is kept.</span></div>
        <div class="kv"><span class="k">Stop loss</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Full sell when price drops SL% below entry.</span></div>
        <div class="kv"><span class="k">Trailing stop</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Full sell when price drops trail% from its peak.</span></div>
        <div class="kv"><span class="k">Moon bag</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">% of tokens kept after TP. Rides with trailing stop only.</span></div>
        <div class="kv"><span class="k">Re-entry</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">After TP, auto-buy back when price dips re-entry% from sell.</span></div>
        <div class="kv"><span class="k">Min market cap</span><span class="v" style="font-family:var(--sans);font-weight:400;color:var(--muted)">Force-close if mcap drops below this. Blocks new LORE trades too.</span></div>
      </div>
    </div>`,
    scripts: `
let strat = null;

function kvRow(label, val) {
  return '<div class="kv"><span class="k">' + label + '</span><span class="v">' + val + '</span></div>';
}

async function load() {
  const res = await api('/snipe/strategy');
  if (!res || !res.defaultStrategy) return;
  strat = res.defaultStrategy;
  const el = $('#strategy-view');
  const minMcap = res.minMarketCapUsd || 5000;
  el.innerHTML =
    kvRow('Take profit', strat.takeProfitPct + '%') +
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

async function save(e) {
  e.preventDefault();
  const body = {};
  const tp = $('#f-tp').value; if (tp) body.takeProfitPct = Number(tp);
  const sl = $('#f-sl').value; if (sl) body.stopLossPct = Number(sl);
  const tr = $('#f-trail').value; if (tr) body.trailingStopPct = Number(tr);
  const mb = $('#f-moon').value; if (mb !== '') body.moonBagPct = Number(mb);
  const rd = $('#f-redip').value; if (rd) body.reEntryDipPct = Number(rd);
  const rs = $('#f-resol').value; if (rs) body.reEntryAmountSol = Number(rs);
  const mr = $('#f-maxre').value; if (mr !== '') body.maxReEntries = Number(mr);

  if (!Object.keys(body).length) return;

  const res = await fetch(BASE + '/snipe/strategy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => null);

  const ok = $('#msg-ok');
  const err = $('#msg-err');
  ok.style.display = 'none';
  err.style.display = 'none';

  if (res && res.defaultStrategy) {
    ok.style.display = 'block';
    setTimeout(() => ok.style.display = 'none', 3000);
    $('#strategy-form').reset();
    load();
  } else {
    err.textContent = (res && res.error) ? res.error : 'Failed to save.';
    err.style.display = 'block';
    setTimeout(() => err.style.display = 'none', 4000);
  }
}

load();
`,
  });
}
