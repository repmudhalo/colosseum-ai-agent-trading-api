/**
 * Shared layout shell for all Sesame dashboard pages.
 * Provides the sidebar, CSS variables, and page structure.
 */

export function dashboardShell(opts: {
  title: string;
  activeNav: 'dashboard' | 'portfolio' | 'trades' | 'strategy' | 'lore';
  bodyContent: string;
  scripts: string;
}): string {
  const navItems = [
    { id: 'dashboard', href: '/dashboard', label: 'Dashboard', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { id: 'portfolio', href: '/dashboard/portfolio', label: 'Portfolio', icon: '<path d="M12 2v20M2 12h20"/>' },
    { id: 'trades', href: '/dashboard/trades', label: 'Trade History', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
    { id: 'strategy', href: '/dashboard/strategy', label: 'Strategy', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9"/>' },
  ];

  const integrationItems = [
    { id: 'lore', href: '/lore/status', label: 'LORE', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', external: true },
    { id: 'health', href: '/health', label: 'Health', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', external: true },
  ];

  const renderNav = (items: typeof navItems) => items.map((n) => {
    const active = n.id === opts.activeNav ? ' active' : '';
    const ext = (n as { external?: boolean }).external;
    const click = ext ? ` onclick="window.open('${n.href}','_blank')"` : ` onclick="location.href='${n.href}'"`;
    return `<div class="nav-item${active}"${click}><svg viewBox="0 0 24 24">${n.icon}</svg>${n.label}</div>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sesame — ${opts.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0f;--bg2:#111118;--bg3:#16161f;--card:#12121a;--border:#1e1e2a;
  --accent:#c8ff00;--accent-dim:rgba(200,255,0,.12);
  --red:#ef4444;--green:#22c55e;--cyan:#06b6d4;
  --text:#e4e4e7;--muted:#71717a;
  --mono:'SF Mono',Monaco,Consolas,'Liberation Mono',monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,sans-serif;
}
html{scroll-behavior:smooth}
body{font-family:var(--sans);background:var(--bg);color:var(--text);min-height:100vh}
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
@media(max-width:800px){.shell{grid-template-columns:1fr}}
.sidebar{background:var(--bg2);border-right:1px solid var(--border);padding:1.5rem 1rem;display:flex;flex-direction:column;gap:2rem}
@media(max-width:800px){.sidebar{display:none}}
.logo{font-size:1.1rem;font-weight:700;letter-spacing:-.5px;color:#fff;display:flex;align-items:center;gap:8px;cursor:pointer}
.logo svg{width:22px;height:22px;fill:var(--accent)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:.82rem;font-weight:500;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.nav-item:hover{background:rgba(255,255,255,.04);color:var(--text)}
.nav-item.active{background:var(--accent-dim);color:var(--accent)}
.nav-item svg{width:16px;height:16px;flex-shrink:0;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.nav-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);padding:0 12px;margin-top:.5rem}
.main{padding:2rem 2.5rem;overflow-y:auto}
@media(max-width:800px){.main{padding:1.2rem}}
.page-title{font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:.25rem}
.page-sub{font-size:.82rem;color:var(--muted);margin-bottom:1.5rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.card-title{font-size:.82rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.card-title svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.stat-big{font-size:1.8rem;font-weight:700;color:#fff;font-family:var(--mono);letter-spacing:-.5px}
.stat-label{font-size:.72rem;color:var(--muted);margin-top:2px}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}
@media(max-width:900px){.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}}
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
.badge-closed{background:rgba(113,113,122,.12);color:var(--muted)}
.badge-moon{background:rgba(200,255,0,.12);color:var(--accent)}
.badge-auto{background:rgba(167,139,250,.12);color:#a78bfa}
.badge-lore{background:rgba(6,182,212,.12);color:var(--cyan)}
.pnl-pos{color:var(--green);font-weight:600;font-family:var(--mono)}
.pnl-neg{color:var(--red);font-weight:600;font-family:var(--mono)}
.pnl-zero{color:var(--muted);font-family:var(--mono)}
.empty-state{padding:2rem;text-align:center;color:var(--muted);font-size:.82rem}
.kv-list{display:flex;flex-direction:column;gap:6px}
.kv{display:flex;justify-content:space-between;align-items:center}
.kv .k{color:var(--muted);font-size:.78rem}
.kv .v{color:var(--text);font-size:.78rem;font-weight:600;font-family:var(--mono)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot-ok{background:var(--green);box-shadow:0 0 6px rgba(34,197,94,.4)}
.dot-off{background:var(--red);box-shadow:0 0 6px rgba(239,68,68,.3)}
.btn{background:none;border:1px solid var(--border);color:var(--muted);padding:6px 14px;border-radius:6px;font-size:.75rem;cursor:pointer;transition:all .15s;font-family:var(--sans)}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-accent{background:var(--accent-dim);border-color:rgba(200,255,0,.3);color:var(--accent)}
.btn-accent:hover{background:rgba(200,255,0,.2)}
input[type="number"],input[type="text"]{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;font-size:.82rem;font-family:var(--mono);width:100%;outline:none;transition:border .15s}
input:focus{border-color:var(--accent)}
label{font-size:.75rem;color:var(--muted);display:block;margin-bottom:4px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:600px){.form-row{grid-template-columns:1fr}}
.form-group{margin-bottom:1rem}
.msg{padding:10px 14px;border-radius:8px;font-size:.78rem;margin-top:1rem;display:none}
.msg-ok{background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.2)}
.msg-err{background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.2)}
.tab-bar{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:1.5rem}
.tab{padding:10px 20px;font-size:.82rem;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.solscan-link{color:var(--cyan);text-decoration:none;font-family:var(--mono);font-size:.72rem}
.solscan-link:hover{text-decoration:underline}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="logo" onclick="location.href='/dashboard'">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5" stroke="#0a0a0f" stroke-width="2.5" fill="none"/></svg>
      Sesame
    </div>
    <nav class="nav">${renderNav(navItems)}</nav>
    <div class="nav-label">Integrations</div>
    <nav class="nav">${renderNav(integrationItems)}</nav>
    <div style="margin-top:auto;padding:8px 12px;font-size:.68rem;color:var(--muted)">
      <span id="sidebar-uptime">--</span> uptime
    </div>
  </aside>
  <main class="main">
    ${opts.bodyContent}
  </main>
</div>
<script>
const $=s=>document.querySelector(s);
const BASE=location.origin;
async function api(path,opts){try{const r=await fetch(BASE+path,opts);return await r.json();}catch{return null;}}
function duration(iso){const ms=Date.now()-new Date(iso).getTime();const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+s%60+'s';const h=Math.floor(m/60);if(h<24)return h+'h '+m%60+'m';return Math.floor(h/24)+'d '+h%24+'h';}
function shortMint(m){return m?m.slice(0,4)+'...'+m.slice(-4):'--';}
function solStr(v){return v!=null?parseFloat(v).toFixed(4):'--';}
function usdStr(v){return v!=null?'$'+parseFloat(v).toFixed(6):'--';}
function pnlClass(v){return v>0?'pnl-pos':v<0?'pnl-neg':'pnl-zero';}
function pnlStr(v){return (v>0?'+':'')+v.toFixed(2)+'%';}
(async function(){const h=await api('/health');if(h&&h.uptimeSeconds!=null){const s=h.uptimeSeconds;const el=$('#sidebar-uptime');if(s<60)el.textContent=s+'s';else if(s<3600)el.textContent=Math.floor(s/60)+'m';else if(s<86400)el.textContent=Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m';else el.textContent=Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h';}})();
${opts.scripts}
</script>
</body>
</html>`;
}
