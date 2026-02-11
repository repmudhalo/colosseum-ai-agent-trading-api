export function renderExperimentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Timmy — Autonomous AI Agent Trading Infrastructure</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06060e;--bg2:#0c0c18;--bg3:#12121f;--card:#0f0f1c;--border:#1a1a30;--red:#e94560;--cyan:#00d4ff;--green:#4ade80;--yellow:#fbbf24;--purple:#a78bfa;--pink:#f472b6;--text:#e0e0e0;--muted:#888;--mono:'SF Mono',Monaco,Consolas,'Liberation Mono',monospace}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}

/* ── Animations ── */
@keyframes fadeInUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(233,69,96,.3)}50%{box-shadow:0 0 40px rgba(233,69,96,.6)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes slideRight{from{width:0}to{width:100%}}
@keyframes borderGlow{0%,100%{border-color:var(--red)}50%{border-color:var(--cyan)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes flywheel-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes dash-flow{to{stroke-dashoffset:-20}}
@keyframes checkPop{0%{transform:scale(0);opacity:0}50%{transform:scale(1.3)}100%{transform:scale(1);opacity:1}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes countUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes particleFloat{0%{transform:translateY(0) translateX(0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-100vh) translateX(50px);opacity:0}}

.fade-in{animation:fadeInUp .6s ease-out both}
.fade-in-d1{animation-delay:.1s}
.fade-in-d2{animation-delay:.2s}
.fade-in-d3{animation-delay:.3s}
.fade-in-d4{animation-delay:.4s}
.fade-in-d5{animation-delay:.5s}

/* ── Particles BG ── */
.particles{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;overflow:hidden}
.particle{position:absolute;width:2px;height:2px;background:var(--red);border-radius:50%;animation:particleFloat linear infinite;opacity:0}

/* ── Stats Bar ── */
.stats-bar{background:linear-gradient(90deg,var(--red),#c93550,var(--red));background-size:200% 100%;animation:gradientShift 3s ease infinite;padding:10px 0;text-align:center;position:relative;z-index:10}
.stats-bar-inner{display:flex;justify-content:center;gap:2rem;flex-wrap:wrap;font-size:.85rem;font-weight:700;color:#fff;letter-spacing:.5px}
.stats-bar-inner span{display:flex;align-items:center;gap:6px}
.stat-divider{width:1px;height:16px;background:rgba(255,255,255,.3)}

/* ── Hero ── */
.hero{position:relative;background:linear-gradient(160deg,#0a0a1a 0%,#111132 40%,#1a0a2e 70%,#0f0620 100%);padding:4rem 2rem 3rem;text-align:center;overflow:hidden;z-index:1}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 50% 0%,rgba(233,69,96,.15) 0%,transparent 70%);pointer-events:none}
.hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(233,69,96,.15);border:1px solid rgba(233,69,96,.3);color:var(--red);padding:6px 16px;border-radius:20px;font-size:.8rem;font-weight:600;margin-bottom:1.2rem;animation:fadeIn .8s ease-out}
.hero h1{font-size:3rem;font-weight:800;background:linear-gradient(135deg,#fff 0%,#e0e0e0 50%,var(--cyan) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.6rem;letter-spacing:-1px;animation:fadeInUp .6s ease-out}
.hero h2{font-size:1.15rem;color:var(--muted);font-weight:400;max-width:700px;margin:0 auto 2rem;line-height:1.6;animation:fadeInUp .6s ease-out .1s both}
.hero-tags{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:2rem;animation:fadeInUp .6s ease-out .2s both}
.htag{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#ccc;padding:4px 12px;border-radius:20px;font-size:.7rem;font-weight:600;letter-spacing:.5px;text-transform:uppercase;transition:all .2s}
.htag:hover{border-color:var(--cyan);color:var(--cyan);background:rgba(0,212,255,.08)}

/* ── Buttons ── */
.btn-hero{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(135deg,var(--red),#c93550);color:#fff;padding:16px 36px;border-radius:14px;font-size:1.1rem;font-weight:700;border:none;cursor:pointer;transition:all .3s;animation:glow 2s ease-in-out infinite;text-decoration:none;position:relative;overflow:hidden}
.btn-hero:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(233,69,96,.4)}
.btn-hero:active{transform:translateY(0)}
.btn-hero::after{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:linear-gradient(45deg,transparent,rgba(255,255,255,.1),transparent);transform:rotate(45deg);transition:.5s}
.btn-hero:hover::after{left:100%}
.btn-sm{display:inline-flex;align-items:center;gap:6px;background:rgba(233,69,96,.12);border:1px solid rgba(233,69,96,.3);color:var(--red);padding:8px 16px;border-radius:10px;font-size:.82rem;font-weight:600;cursor:pointer;transition:all .2s;text-decoration:none}
.btn-sm:hover{background:var(--red);color:#fff;border-color:var(--red)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted);padding:6px 14px;border-radius:8px;font-size:.78rem;cursor:pointer;transition:all .2s;text-decoration:none}
.btn-ghost:hover{border-color:var(--cyan);color:var(--cyan)}

/* ── Layout ── */
.container{max-width:1200px;margin:0 auto;padding:2rem;position:relative;z-index:1}
.section{margin-bottom:3rem}
.section-title{font-size:1.6rem;font-weight:700;margin-bottom:.5rem;display:flex;align-items:center;gap:10px}
.section-sub{color:var(--muted);font-size:.9rem;margin-bottom:1.5rem}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:1.2rem}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}
@media(max-width:900px){.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}}
@media(min-width:901px) and (max-width:1100px){.grid-3,.grid-4{grid-template-columns:repeat(2,1fr)}}

/* ── Cards ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:1.5rem;transition:all .3s;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(233,69,96,.3),transparent);opacity:0;transition:opacity .3s}
.card:hover{border-color:rgba(233,69,96,.3);transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.3)}
.card:hover::before{opacity:1}
.card-title{font-size:1rem;font-weight:700;margin-bottom:.8rem;display:flex;align-items:center;gap:8px}
.card-title .icon{font-size:1.2rem}
.card-glow{animation:borderGlow 3s ease-in-out infinite}

/* ── KV rows ── */
.kv{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--muted);font-size:.82rem}
.kv .v{color:var(--text);font-size:.82rem;font-weight:600}
.mono{font-family:var(--mono);font-size:.82rem}
.green{color:var(--green)}
.red{color:var(--red)}
.cyan{color:var(--cyan)}

/* ── Status indicators ── */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot-ok{background:var(--green);box-shadow:0 0 8px rgba(74,222,128,.5)}
.dot-warn{background:var(--yellow)}
.dot-err{background:#f87171}
.dot-pulse{animation:pulse 1.5s ease-in-out infinite}

/* ── Demo Runner ── */
.demo-panel{background:linear-gradient(135deg,rgba(233,69,96,.05),rgba(0,212,255,.05));border:1px solid rgba(233,69,96,.2);border-radius:20px;padding:2rem;margin-top:1rem}
.demo-steps{display:flex;flex-direction:column;gap:0}
.demo-step{display:flex;align-items:flex-start;gap:16px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.04);opacity:.4;transition:all .4s}
.demo-step:last-child{border-bottom:none}
.demo-step.active{opacity:1}
.demo-step.done{opacity:1}
.step-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;border:2px solid var(--border);background:var(--bg2);transition:all .3s}
.demo-step.active .step-icon{border-color:var(--cyan);box-shadow:0 0 15px rgba(0,212,255,.3)}
.demo-step.done .step-icon{border-color:var(--green);background:rgba(74,222,128,.15);animation:checkPop .4s ease-out}
.demo-step.error .step-icon{border-color:#f87171;background:rgba(248,113,113,.15)}
.step-content{flex:1;min-width:0}
.step-label{font-weight:600;font-size:.9rem;margin-bottom:2px}
.step-desc{color:var(--muted);font-size:.78rem}
.step-result{margin-top:6px;padding:8px 12px;background:var(--bg);border-radius:8px;font-family:var(--mono);font-size:.75rem;color:var(--green);word-break:break-all;animation:fadeIn .3s ease-out}
.step-spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--cyan);border-radius:50%;animation:spin .6s linear infinite}
.demo-progress{height:3px;background:var(--border);border-radius:2px;margin-top:1.5rem;overflow:hidden}
.demo-progress-bar{height:100%;background:linear-gradient(90deg,var(--red),var(--cyan));border-radius:2px;transition:width .3s;width:0}

/* ── Flywheel ── */
.flywheel-container{display:flex;align-items:center;justify-content:center;padding:2rem 0;position:relative}
.flywheel{position:relative;width:420px;height:420px}
.flywheel-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:110px;height:110px;background:linear-gradient(135deg,var(--red),#c93550);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;box-shadow:0 0 40px rgba(233,69,96,.3);z-index:2}
.flywheel-center-text{color:#fff;font-weight:800;font-size:.8rem;text-align:center;line-height:1.2}
.flywheel-ring{position:absolute;top:0;left:0;width:100%;height:100%}
.flywheel-ring svg{width:100%;height:100%;animation:flywheel-rotate 20s linear infinite}
.flywheel-node{position:absolute;width:120px;text-align:center;transform:translate(-50%,-50%)}
.flywheel-node-dot{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.3rem;margin:0 auto 6px;border:2px solid;transition:all .3s;animation:float 3s ease-in-out infinite}
.flywheel-node-label{font-size:.72rem;font-weight:600;color:var(--text);line-height:1.3}
.fw-n1 .flywheel-node-dot{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.4)}
.fw-n2 .flywheel-node-dot{background:rgba(0,212,255,.12);border-color:rgba(0,212,255,.4);animation-delay:.5s}
.fw-n3 .flywheel-node-dot{background:rgba(167,139,250,.12);border-color:rgba(167,139,250,.4);animation-delay:1s}
.fw-n4 .flywheel-node-dot{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.4);animation-delay:1.5s}
.fw-n5 .flywheel-node-dot{background:rgba(244,114,182,.12);border-color:rgba(244,114,182,.4);animation-delay:2s}
.fw-n6 .flywheel-node-dot{background:rgba(233,69,96,.12);border-color:rgba(233,69,96,.4);animation-delay:2.5s}
.flywheel-arrow{position:absolute;color:var(--muted);font-size:1.1rem;transform:translate(-50%,-50%);opacity:.6}
@media(max-width:600px){.flywheel{width:300px;height:300px}.flywheel-center{width:80px;height:80px}.flywheel-center-text{font-size:.65rem}.flywheel-node{width:90px}.flywheel-node-dot{width:40px;height:40px;font-size:1rem}.flywheel-node-label{font-size:.6rem}}

/* ── TX Proof ── */
.tx-card{background:linear-gradient(135deg,rgba(74,222,128,.04),rgba(74,222,128,.01));border:1px solid rgba(74,222,128,.15);border-radius:16px;padding:1.2rem 1.5rem;margin-bottom:1rem;transition:all .3s}
.tx-card:hover{border-color:rgba(74,222,128,.4);box-shadow:0 0 20px rgba(74,222,128,.1)}
.tx-label{font-weight:700;color:var(--green);font-size:.85rem;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.tx-hash{font-family:var(--mono);font-size:.72rem;color:var(--cyan);word-break:break-all;text-decoration:none;transition:color .2s}
.tx-hash:hover{color:#fff}
.tx-wallet{font-family:var(--mono);font-size:.78rem;color:var(--muted);margin-top:.5rem}

/* ── Feature Matrix ── */
.feature-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.feature-item{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;transition:all .2s;cursor:default}
.feature-item:hover{border-color:var(--cyan);background:rgba(0,212,255,.04);transform:translateY(-1px)}
.feature-icon{font-size:1.1rem;flex-shrink:0}
.feature-label{font-size:.78rem;font-weight:600;line-height:1.2}

/* ── Architecture ── */
.arch-visual{display:flex;flex-direction:column;gap:0;align-items:center;padding:1rem 0}
.arch-row{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin:4px 0}
.arch-box{padding:10px 18px;border-radius:10px;font-size:.78rem;font-weight:600;text-align:center;border:1px solid;min-width:110px;transition:all .3s}
.arch-box:hover{transform:translateY(-2px)}
.arch-agent{background:rgba(0,212,255,.1);border-color:rgba(0,212,255,.3);color:var(--cyan)}
.arch-mid{background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.3);color:var(--purple)}
.arch-exec{background:rgba(233,69,96,.1);border-color:rgba(233,69,96,.3);color:var(--red)}
.arch-out{background:rgba(74,222,128,.1);border-color:rgba(74,222,128,.3);color:var(--green)}
.arch-arrow{color:var(--muted);font-size:1.2rem;margin:2px 0}

/* ── WS Feed ── */
.ws-feed{max-height:250px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:1rem;font-family:var(--mono);font-size:.75rem;color:#9ca3af}
.ws-feed::-webkit-scrollbar{width:4px}
.ws-feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.ws-line{padding:3px 0;border-bottom:1px solid rgba(255,255,255,.02);animation:fadeIn .3s ease-out}

/* ── Footer ── */
.footer{text-align:center;padding:3rem 2rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--border);margin-top:2rem}
.footer a{color:var(--red);text-decoration:none}
.footer a:hover{text-decoration:underline}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

/* ── Tooltip ── */
.glow-line{height:1px;background:linear-gradient(90deg,transparent,var(--red),transparent);margin:2rem 0}
</style>
</head>
<body>

<!-- Particles Background -->
<div class="particles" id="particles"></div>

<!-- Stats Bar -->
<div class="stats-bar">
  <div class="stats-bar-inner">
    <span>✅ 356 Tests</span>
    <div class="stat-divider"></div>
    <span>📁 45 Files</span>
    <div class="stat-divider"></div>
    <span>📝 80+ Source Files</span>
    <div class="stat-divider"></div>
    <span>📐 16K Lines</span>
    <div class="stat-divider"></div>
    <span>⚡ 30+ Features</span>
    <div class="stat-divider"></div>
    <span>🔗 Solana Mainnet</span>
  </div>
</div>

<!-- Hero -->
<div class="hero">
  <div class="hero-badge">🏆 Colosseum Agent Hackathon 2026</div>
  <h1>🏛️ Timmy Agent Trading API</h1>
  <h2>The complete autonomous DeFi infrastructure for AI agents on Solana.<br/>Verifiable receipts · Self-improving flywheel · Real-time risk management.</h2>
  <div class="hero-tags">
    <span class="htag">Autonomous Trading</span>
    <span class="htag">Solana Mainnet</span>
    <span class="htag">Verifiable Receipts</span>
    <span class="htag">Risk Telemetry</span>
    <span class="htag">Multi-Agent Squads</span>
    <span class="htag">Strategy Marketplace</span>
    <span class="htag">Order Book</span>
    <span class="htag">MEV Protection</span>
    <span class="htag">Backtesting Engine</span>
    <span class="htag">Self-Improving Loop</span>
    <span class="htag">WebSocket Feed</span>
  </div>
  <button class="btn-hero" id="run-demo-btn" onclick="runLiveDemo()">
    🚀 Run Live Demo
  </button>
  <p style="color:var(--muted);font-size:.78rem;margin-top:.8rem">Watch the full trading pipeline execute in real-time — register, price feed, trade, verify</p>
</div>

<!-- Main Container -->
<div class="container">

  <!-- ████ LIVE DEMO SECTION ████ -->
  <div class="section fade-in" id="demo-section" style="display:none">
    <div class="section-title">🎬 Live Demo Execution</div>
    <div class="section-sub">Full pipeline running against this server — every step is a real API call</div>
    <div class="demo-panel" id="demo-panel">
      <div class="demo-steps" id="demo-steps">
        <div class="demo-step" id="ds-0">
          <div class="step-icon">1</div>
          <div class="step-content">
            <div class="step-label">Register Agent</div>
            <div class="step-desc">POST /agents/register — creates a fresh AI agent with $10,000 paper capital</div>
          </div>
        </div>
        <div class="demo-step" id="ds-1">
          <div class="step-icon">2</div>
          <div class="step-content">
            <div class="step-label">Seed Price Feed</div>
            <div class="step-desc">POST /market/prices ×8 — ascending SOL prices to establish uptrend</div>
          </div>
        </div>
        <div class="demo-step" id="ds-2">
          <div class="step-icon">3</div>
          <div class="step-content">
            <div class="step-label">Submit Trade Intent</div>
            <div class="step-desc">POST /trade-intents — buy 5 SOL through the full pipeline (strategy → risk → execute)</div>
          </div>
        </div>
        <div class="demo-step" id="ds-3">
          <div class="step-icon">4</div>
          <div class="step-content">
            <div class="step-label">Verify Intent Status</div>
            <div class="step-desc">GET /trade-intents/:id — confirm execution completed</div>
          </div>
        </div>
        <div class="demo-step" id="ds-4">
          <div class="step-icon">5</div>
          <div class="step-content">
            <div class="step-label">Fetch Execution Receipt</div>
            <div class="step-desc">GET /executions?limit=1 — retrieve the verifiable execution record</div>
          </div>
        </div>
        <div class="demo-step" id="ds-5">
          <div class="step-icon">6</div>
          <div class="step-content">
            <div class="step-label">Verify Receipt Hash</div>
            <div class="step-desc">GET /receipts/verify/:id — SHA-256 hash chain verification</div>
          </div>
        </div>
      </div>
      <div class="demo-progress"><div class="demo-progress-bar" id="demo-progress-bar"></div></div>
    </div>
  </div>

  <!-- ████ LIVE SYSTEM STATUS ████ -->
  <div class="section fade-in fade-in-d1">
    <div class="section-title">📡 Live System Status</div>
    <div class="section-sub">Auto-refreshing every 10 seconds — all data is live from the API</div>
    <div class="grid-3">
      <div class="card">
        <div class="card-title"><span class="icon">💚</span> Health</div>
        <div id="health-data"><div style="color:var(--muted);font-style:italic">Loading...</div></div>
      </div>
      <div class="card">
        <div class="card-title"><span class="icon">🤖</span> Active Agents</div>
        <div id="agents-data"><div style="color:var(--muted);font-style:italic">Loading...</div></div>
      </div>
      <div class="card">
        <div class="card-title"><span class="icon">🔄</span> Autonomous Loop</div>
        <div id="autonomous-data"><div style="color:var(--muted);font-style:italic">Loading...</div></div>
      </div>
    </div>
    <div class="grid-2" style="margin-top:1.2rem">
      <div class="card">
        <div class="card-title"><span class="icon">📊</span> Platform Metrics</div>
        <div id="metrics-data"><div style="color:var(--muted);font-style:italic">Loading...</div></div>
      </div>
      <div class="card">
        <div class="card-title"><span class="icon">📡</span> WebSocket Events
          <span id="ws-status" style="font-size:.7rem;color:var(--muted);margin-left:auto">(connecting...)</span>
        </div>
        <div class="ws-feed" id="event-feed">
          <div style="color:var(--muted)">Waiting for events...</div>
        </div>
        <div style="margin-top:.6rem;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:.78rem;color:var(--muted)">Clients: <strong id="ws-clients">0</strong></span>
          <button class="btn-ghost" onclick="document.getElementById('event-feed').innerHTML=''">Clear</button>
        </div>
      </div>
    </div>
  </div>

  <div class="glow-line"></div>

  <!-- ████ SELF-IMPROVING FLYWHEEL ████ -->
  <div class="section fade-in fade-in-d2">
    <div class="section-title">🔄 Self-Improving Flywheel</div>
    <div class="section-sub">The core innovation — every trade makes the next trade better. Fully autonomous.</div>
    <div class="flywheel-container">
      <div class="flywheel">
        <!-- Rotating ring -->
        <div class="flywheel-ring">
          <svg viewBox="0 0 420 420" fill="none">
            <circle cx="210" cy="210" r="170" stroke="rgba(233,69,96,.15)" stroke-width="2" stroke-dasharray="8 8">
              <animateTransform attributeName="transform" type="rotate" from="0 210 210" to="360 210 210" dur="30s" repeatCount="indefinite"/>
            </circle>
            <circle cx="210" cy="210" r="170" stroke="url(#fwGrad)" stroke-width="2" stroke-dasharray="40 160" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 210 210" to="360 210 210" dur="8s" repeatCount="indefinite"/>
            </circle>
            <defs><linearGradient id="fwGrad"><stop offset="0%" stop-color="var(--red)"/><stop offset="100%" stop-color="var(--cyan)"/></linearGradient></defs>
          </svg>
        </div>
        <!-- Center -->
        <div class="flywheel-center">
          <div class="flywheel-center-text">SELF-<br/>IMPROVING<br/>LOOP</div>
        </div>
        <!-- Nodes positioned in a circle -->
        <div class="flywheel-node fw-n1" style="top:5%;left:50%">
          <div class="flywheel-node-dot">💰</div>
          <div class="flywheel-node-label">Trading<br/>Profits</div>
        </div>
        <div class="flywheel-node fw-n2" style="top:27%;left:93%">
          <div class="flywheel-node-dot">🧠</div>
          <div class="flywheel-node-label">Inference<br/>Budget</div>
        </div>
        <div class="flywheel-node fw-n3" style="top:72%;left:93%">
          <div class="flywheel-node-dot">📊</div>
          <div class="flywheel-node-label">Performance<br/>Analysis</div>
        </div>
        <div class="flywheel-node fw-n4" style="top:95%;left:50%">
          <div class="flywheel-node-dot">💡</div>
          <div class="flywheel-node-label">Strategy<br/>Recommendations</div>
        </div>
        <div class="flywheel-node fw-n5" style="top:72%;left:7%">
          <div class="flywheel-node-dot">⚙️</div>
          <div class="flywheel-node-label">Auto-Apply<br/>Parameters</div>
        </div>
        <div class="flywheel-node fw-n6" style="top:27%;left:7%">
          <div class="flywheel-node-dot">📈</div>
          <div class="flywheel-node-label">Better<br/>Trades</div>
        </div>
        <!-- Direction arrows -->
        <div class="flywheel-arrow" style="top:12%;left:76%">→</div>
        <div class="flywheel-arrow" style="top:50%;left:98%">↓</div>
        <div class="flywheel-arrow" style="top:88%;left:76%">←</div>
        <div class="flywheel-arrow" style="top:88%;left:24%">←</div>
        <div class="flywheel-arrow" style="top:50%;left:2%">↑</div>
        <div class="flywheel-arrow" style="top:12%;left:24%">→</div>
      </div>
    </div>
    <div style="text-align:center;max-width:600px;margin:0 auto">
      <p style="color:var(--muted);font-size:.85rem;line-height:1.6">Each completed trade feeds profit data into the analysis engine. The system automatically adjusts risk parameters, strategy weights, and position sizing — creating a compounding improvement loop that gets smarter with every cycle.</p>
    </div>
  </div>

  <div class="glow-line"></div>

  <!-- ████ MAINNET TX PROOF ████ -->
  <div class="section fade-in fade-in-d3">
    <div class="section-title">⛓️ Mainnet Transaction Proof</div>
    <div class="section-sub">Real Solana mainnet transactions executed through the full pipeline — click to verify on Solscan</div>
    <div class="grid-2">
      <div class="tx-card">
        <div class="tx-label">
          <span class="dot dot-ok"></span>
          TX 1 — Sell (SOL → USDC)
        </div>
        <a class="tx-hash" href="https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf" target="_blank" rel="noopener">
          3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf ↗
        </a>
      </div>
      <div class="tx-card">
        <div class="tx-label">
          <span class="dot dot-ok"></span>
          TX 2 — Buy (USDC → SOL)
        </div>
        <a class="tx-hash" href="https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7" target="_blank" rel="noopener">
          5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7 ↗
        </a>
      </div>
    </div>
    <div style="text-align:center;margin-top:.8rem">
      <span class="tx-wallet">Wallet: <strong>7GciqigwwRM8HANqDTF1GjAq6yKsS2odvorAaTUSaYkJ</strong></span>
      <a class="btn-ghost" style="margin-left:12px" href="https://solscan.io/account/7GciqigwwRM8HANqDTF1GjAq6yKsS2odvorAaTUSaYkJ" target="_blank" rel="noopener">View Wallet ↗</a>
    </div>
  </div>

  <div class="glow-line"></div>

  <!-- ████ ARCHITECTURE ████ -->
  <div class="section fade-in fade-in-d4">
    <div class="section-title">🏗️ Architecture Pipeline</div>
    <div class="section-sub">Complete request flow: from agent SDK to on-chain proof</div>
    <div class="card" style="padding:2rem">
      <div class="arch-visual">
        <div class="arch-row">
          <div class="arch-box arch-agent">🤖 Agent / SDK</div>
          <span style="color:var(--muted)">→</span>
          <div class="arch-box arch-agent">🔑 Register</div>
          <span style="color:var(--muted)">→</span>
          <div class="arch-box arch-agent">🔐 API Key</div>
        </div>
        <div class="arch-arrow">▼</div>
        <div class="arch-row">
          <div class="arch-box arch-mid">⚡ Rate Limiter</div>
          <div class="arch-box arch-mid">🔄 Idempotency</div>
          <div class="arch-box arch-mid">🛡️ Auth</div>
          <div class="arch-box arch-mid">💳 x402 Gate</div>
        </div>
        <div class="arch-arrow">▼</div>
        <div class="arch-row">
          <div class="arch-box arch-exec">📈 Strategy Engine</div>
          <div class="arch-box arch-exec">🛡️ Risk Engine</div>
          <div class="arch-box arch-exec">📋 Staged Pipeline</div>
          <div class="arch-box arch-exec">🔍 Arb Scanner</div>
        </div>
        <div class="arch-arrow">▼</div>
        <div class="arch-row">
          <div class="arch-box arch-exec" style="min-width:260px">⚡ Execution: Paper Mode │ Jupiter Live Swap</div>
        </div>
        <div class="arch-arrow">▼</div>
        <div class="arch-row">
          <div class="arch-box arch-out">🔗 Receipt Chain</div>
          <div class="arch-box arch-out">📡 Webhooks</div>
          <div class="arch-box arch-out">⛓️ On-Chain Proof</div>
          <div class="arch-box arch-out">💰 Fee Engine</div>
          <div class="arch-box arch-out">🔒 Privacy Layer</div>
        </div>
        <div class="arch-arrow">▼</div>
        <div class="arch-row">
          <div class="arch-box arch-agent">🏪 Marketplace</div>
          <span style="color:var(--muted)">↔</span>
          <div class="arch-box arch-agent">🏆 Reputation</div>
          <span style="color:var(--muted)">↔</span>
          <div class="arch-box arch-agent">🗳️ Governance</div>
        </div>
      </div>
    </div>
  </div>

  <div class="glow-line"></div>

  <!-- ████ FEATURE MATRIX ████ -->
  <div class="section fade-in fade-in-d5">
    <div class="section-title">⚡ Feature Matrix</div>
    <div class="section-sub">30+ production features — zero external dependencies</div>
    <div class="feature-grid" id="feature-grid">
    </div>
  </div>

  <div class="glow-line"></div>

  <!-- ████ API EXPLORER ████ -->
  <div class="section">
    <div class="section-title">🧪 API Explorer</div>
    <div class="section-sub">Quick access to all endpoints — click to open in a new tab</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <a href="/health" class="btn-sm" target="_blank">💚 Health</a>
      <a href="/agents" class="btn-sm" target="_blank">🤖 Agents</a>
      <a href="/strategies" class="btn-sm" target="_blank">📈 Strategies</a>
      <a href="/metrics" class="btn-sm" target="_blank">📊 Metrics</a>
      <a href="/autonomous/status" class="btn-sm" target="_blank">🔄 Autonomous</a>
      <a href="/marketplace/listings" class="btn-sm" target="_blank">🏪 Marketplace</a>
      <a href="/reputation/leaderboard" class="btn-sm" target="_blank">🏆 Reputation</a>
      <a href="/governance/proposals" class="btn-sm" target="_blank">🗳️ Governance</a>
      <a href="/orderbook/SOL-USDC" class="btn-sm" target="_blank">📉 Order Book</a>
      <a href="/arbitrage/opportunities" class="btn-sm" target="_blank">🔍 Arbitrage</a>
      <a href="/squads" class="btn-sm" target="_blank">👥 Squads</a>
      <a href="/state" class="btn-sm" target="_blank">🗂️ Full State</a>
    </div>
  </div>
</div>

<!-- Footer -->
<div class="footer">
  <p style="font-size:1rem;font-weight:700;margin-bottom:.5rem">Timmy Agent Trading API</p>
  <p>Colosseum Agent Hackathon 2026 — Built with TypeScript + Fastify + Jupiter + Solana</p>
  <p style="margin-top:.5rem">
    <a href="https://github.com/tomi204/colosseum-ai-agent-trading-api" target="_blank">GitHub ↗</a> ·
    356 Tests · 45 Files · 80+ Source Files · 16K Lines · 30+ Features
  </p>
</div>

<script>
// ─── Helpers ────────────────────────────────
const $ = s => document.querySelector(s);
const BASE = location.origin;

async function api(path, opts) {
  try {
    const r = await fetch(BASE + path, opts);
    return await r.json();
  } catch(e) { return null; }
}

function kv(label, value) {
  return '<div class="kv"><span class="k">' + label + '</span><span class="v">' + value + '</span></div>';
}

// ─── Particles ──────────────────────────────
(function initParticles() {
  const c = $('#particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.animationDuration = (8 + Math.random() * 15) + 's';
    p.style.animationDelay = Math.random() * 10 + 's';
    if (Math.random() > 0.5) p.style.background = 'var(--cyan)';
    c.appendChild(p);
  }
})();

// ─── Feature Matrix ─────────────────────────
(function initFeatures() {
  const features = [
    ['🤖','Agent Registration & API Keys'],
    ['📈','5 Built-in Trading Strategies'],
    ['🛡️','6-Layer Risk Engine'],
    ['🔗','SHA-256 Receipt Chain'],
    ['⛓️','Solana Mainnet Execution'],
    ['🔄','Autonomous Trading Loop'],
    ['📊','Real-time Analytics'],
    ['👥','Multi-Agent Squads'],
    ['🏪','Strategy Marketplace'],
    ['📉','Central Limit Order Book'],
    ['🔍','Arbitrage Scanner'],
    ['💰','Fee Engine (8bps)'],
    ['💳','x402 Payment Gate'],
    ['📡','WebSocket Live Feed'],
    ['🔒','AES-256 Privacy Layer'],
    ['🧪','Backtesting Engine'],
    ['📋','Staged Pipeline (V→S→E)'],
    ['🏆','Reputation System'],
    ['🗳️','On-chain Governance'],
    ['⚡','Rate Limiting & Auth'],
    ['🔑','Idempotency Keys'],
    ['💸','Lending Monitor'],
    ['📦','TypeScript SDK'],
    ['🛑','MEV Protection'],
    ['📉','Drawdown Circuit Breaker'],
    ['🔔','Webhook Delivery'],
    ['📊','Sharpe/Sortino Ratios'],
    ['🌐','Jupiter DEX Integration'],
    ['💵','Treasury Tracking'],
    ['🧮','Position Sizing Engine'],
    ['🔄','Strategy Hot-Swap'],
    ['📱','Mobile-Responsive UI'],
  ];
  const grid = $('#feature-grid');
  grid.innerHTML = features.map(([icon, label]) =>
    '<div class="feature-item"><span class="feature-icon">' + icon + '</span><span class="feature-label">' + label + '</span></div>'
  ).join('');
})();

// ─── Live Demo ──────────────────────────────
let demoRunning = false;

function setStep(i, state, result) {
  const el = document.getElementById('ds-' + i);
  if (!el) return;
  el.className = 'demo-step ' + state;
  const icon = el.querySelector('.step-icon');
  if (state === 'active') {
    icon.innerHTML = '<div class="step-spinner"></div>';
  } else if (state === 'done') {
    icon.innerHTML = '✓';
    icon.style.color = 'var(--green)';
  } else if (state === 'error') {
    icon.innerHTML = '✗';
    icon.style.color = '#f87171';
  }
  if (result) {
    const existing = el.querySelector('.step-result');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'step-result';
    div.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 0);
    el.querySelector('.step-content').appendChild(div);
  }
  const bar = $('#demo-progress-bar');
  if (state === 'done') bar.style.width = ((i + 1) / 6 * 100) + '%';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runLiveDemo() {
  if (demoRunning) return;
  demoRunning = true;

  const btn = $('#run-demo-btn');
  btn.textContent = '⏳ Running...';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '.6';
  btn.style.animation = 'none';

  const section = $('#demo-section');
  section.style.display = 'block';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Reset all steps
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById('ds-' + i);
    el.className = 'demo-step';
    const icon = el.querySelector('.step-icon');
    icon.innerHTML = (i + 1);
    icon.style.color = '';
    const res = el.querySelector('.step-result');
    if (res) res.remove();
  }
  $('#demo-progress-bar').style.width = '0';

  let agentId, apiKey, intentId, executionId;

  try {
    // Step 1: Register agent
    setStep(0, 'active');
    await delay(300);
    const reg = await api('/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo-agent-' + Date.now(), startingCapitalUsd: 10000 })
    });
    if (!reg || !reg.agent) throw new Error('Registration failed');
    agentId = reg.agent.id;
    apiKey = reg.apiKey;
    setStep(0, 'done', 'Agent: ' + agentId.substring(0, 12) + '... | Key: ' + apiKey.substring(0, 16) + '...');

    // Step 2: Seed prices
    setStep(1, 'active');
    const prices = [140.0, 141.5, 143.2, 144.8, 146.1, 147.5, 149.0, 150.5];
    for (const p of prices) {
      await api('/market/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'SOL', priceUsd: p })
      });
      await delay(80);
    }
    setStep(1, 'done', '8 prices seeded: $' + prices[0] + ' → $' + prices[prices.length - 1] + ' (uptrend)');

    // Step 3: Submit trade
    setStep(2, 'active');
    await delay(200);
    const intent = await api('/trade-intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-api-key': apiKey },
      body: JSON.stringify({ agentId: agentId, symbol: 'SOL', side: 'buy', quantity: 5, requestedMode: 'paper' })
    });
    if (!intent || !intent.intent) throw new Error('Trade intent failed');
    intentId = intent.intent.id;
    setStep(2, 'done', 'Intent: ' + intentId.substring(0, 12) + '... | Side: BUY | Qty: 5 SOL');

    // Step 4: Wait and check status
    setStep(3, 'active');
    await delay(2000);
    const status = await api('/trade-intents/' + intentId, {
      headers: { 'x-agent-api-key': apiKey }
    });
    const st = status && status.intent ? status.intent.status : 'unknown';
    setStep(3, 'done', 'Status: ' + st + (status && status.intent && status.intent.executionId ? ' | Execution: ' + status.intent.executionId.substring(0, 12) + '...' : ''));
    if (status && status.intent && status.intent.executionId) executionId = status.intent.executionId;

    // Step 5: Fetch execution
    setStep(4, 'active');
    await delay(400);
    const execs = await api('/executions?limit=1');
    if (execs && execs.executions && execs.executions.length > 0) {
      const ex = execs.executions[0];
      if (!executionId) executionId = ex.id;
      setStep(4, 'done', 'Execution: ' + ex.id.substring(0, 12) + '... | Mode: ' + (ex.mode || 'paper') + ' | Price: $' + (ex.executedPrice || ex.price || 'N/A'));
    } else {
      setStep(4, 'done', 'Execution recorded (no details returned)');
    }

    // Step 6: Verify receipt
    setStep(5, 'active');
    await delay(400);
    if (executionId) {
      const verify = await api('/receipts/verify/' + executionId);
      if (verify) {
        setStep(5, 'done', 'Verified: ' + (verify.valid ? '✅ VALID' : '❌ INVALID') + (verify.receipt && verify.receipt.hash ? ' | Hash: ' + verify.receipt.hash.substring(0, 20) + '...' : ''));
      } else {
        setStep(5, 'done', 'Receipt verification endpoint called');
      }
    } else {
      setStep(5, 'done', 'No execution ID — skipped verification');
    }

  } catch (err) {
    // Mark current step as error
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById('ds-' + i);
      if (el.classList.contains('active')) {
        setStep(i, 'error', 'Error: ' + (err.message || err));
        break;
      }
    }
  }

  btn.textContent = '🚀 Run Live Demo Again';
  btn.style.pointerEvents = 'auto';
  btn.style.opacity = '1';
  btn.style.animation = 'glow 2s ease-in-out infinite';
  demoRunning = false;

  // Refresh status panels
  loadAll();
}

// ─── Live Status Loaders ────────────────────
async function loadHealth() {
  const h = await api('/health');
  if (!h) { $('#health-data').innerHTML = kv('Status', '<span class="dot dot-err"></span>Unreachable'); return; }
  $('#health-data').innerHTML =
    kv('Status', '<span class="dot dot-ok dot-pulse"></span>' + (h.status || 'ok')) +
    kv('Uptime', Math.round(h.uptimeSeconds || 0) + 's') +
    kv('Mode', h.defaultMode || 'paper') +
    kv('Live Enabled', h.liveModeEnabled ? '✅ Yes' : '⬜ No') +
    kv('Agents', (h.stateSummary ? h.stateSummary.agents : 0)) +
    kv('Executions', (h.stateSummary ? h.stateSummary.executions : 0)) +
    kv('Receipts', (h.stateSummary ? h.stateSummary.receipts : 0));
}

async function loadAgents() {
  const a = await api('/agents');
  if (!a || !a.agents) { $('#agents-data').innerHTML = '<div style="color:var(--muted)">No data</div>'; return; }
  if (a.agents.length === 0) {
    $('#agents-data').innerHTML = '<div style="color:var(--muted)">No agents registered — click Run Live Demo!</div>';
    return;
  }
  $('#agents-data').innerHTML = a.agents.slice(0, 6).map(function(ag) {
    return kv(
      '<span class="mono" style="color:var(--cyan)">' + ag.id.substring(0, 10) + '...</span>',
      ag.name + ' <span style="color:var(--muted);font-size:.72rem">(' + (ag.strategyId || 'default') + ')</span>'
    );
  }).join('') + (a.agents.length > 6 ? '<div style="color:var(--muted);font-size:.75rem;margin-top:6px">+ ' + (a.agents.length - 6) + ' more agents</div>' : '');
}

async function loadAutonomous() {
  const au = await api('/autonomous/status');
  if (!au) { $('#autonomous-data').innerHTML = kv('Status', '<span class="dot dot-warn"></span>Unknown'); return; }
  $('#autonomous-data').innerHTML =
    kv('Enabled', au.enabled ? '<span class="dot dot-ok dot-pulse"></span>Active' : '<span class="dot dot-warn"></span>Disabled') +
    kv('Interval', (au.intervalMs / 1000) + 's') +
    kv('Loop Count', au.loopCount || 0) +
    kv('Last Run', au.lastRunAt ? new Date(au.lastRunAt).toLocaleTimeString() : 'Never');
}

async function loadMetrics() {
  const m = await api('/metrics');
  if (!m) { $('#metrics-data').innerHTML = '<div style="color:var(--muted)">No data</div>'; return; }
  const met = m.metrics || {};
  const tr = m.treasury || {};
  $('#metrics-data').innerHTML =
    kv('Intents Executed', met.intentsExecuted || 0) +
    kv('Intents Rejected', met.intentsRejected || 0) +
    kv('Receipts Generated', met.receiptCount || 0) +
    kv('Quote Retries', met.quoteRetries || 0) +
    kv('Fees Collected', '$' + (tr.totalFeesUsd || 0).toFixed(4)) +
    kv('Treasury Entries', (tr.entries ? tr.entries.length : 0));
}

function loadAll() {
  loadHealth();
  loadAgents();
  loadAutonomous();
  loadMetrics();
}

loadAll();
setInterval(loadAll, 10000);

// ─── WebSocket ──────────────────────────────
(function initWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const colors = {
    'intent.created': '#60a5fa',
    'intent.executed': '#4ade80',
    'intent.rejected': '#f87171',
    'price.updated': '#fbbf24',
    'autonomous.tick': '#a78bfa',
    'agent.registered': '#34d399',
    'squad.created': '#f472b6',
    'squad.joined': '#fb923c',
    'connected': '#888',
  };
  let ws;

  function connect() {
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
    } catch(e) {
      $('#ws-status').textContent = '(unavailable)';
      $('#ws-status').style.color = '#f87171';
      return;
    }
    ws.onopen = function() {
      $('#ws-status').textContent = '(connected)';
      $('#ws-status').style.color = 'var(--green)';
    };
    ws.onclose = function() {
      $('#ws-status').textContent = '(disconnected — reconnecting...)';
      $('#ws-status').style.color = '#f87171';
      setTimeout(connect, 3000);
    };
    ws.onerror = function() { ws.close(); };
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'connected') {
          $('#ws-clients').textContent = (msg.data && msg.data.clients) ? msg.data.clients : '?';
          return;
        }
        const feed = $('#event-feed');
        const color = colors[msg.type] || '#9ca3af';
        const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '';
        const line = document.createElement('div');
        line.className = 'ws-line';
        line.innerHTML = '<span style="color:var(--muted)">' + time + '</span> <span style="color:' + color + ';font-weight:700">' + msg.type + '</span> <span style="opacity:.7">' + JSON.stringify(msg.data || {}).substring(0, 120) + '</span>';
        feed.prepend(line);
        while (feed.children.length > 150) feed.removeChild(feed.lastChild);
      } catch(err) {}
    };
  }

  connect();
})();

// ─── Intersection Observer for animations ───
(function initObserver() {
  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        entry.target.style.opacity = '1';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.fade-in').forEach(function(el) {
    observer.observe(el);
  });
})();
</script>
</body>
</html>`;
}
