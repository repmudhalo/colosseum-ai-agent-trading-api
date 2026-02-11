# JUDGES.md — 2-Minute Walkthrough

> **TL;DR:** Run `bash scripts/demo-judge.sh` — it proves safety, auditability, and monetization in one shot.

---

## Live Mainnet Proof

Before anything else — this isn't a paper-only prototype. We executed a real swap on Solana mainnet via Jupiter:

> **TX:** [`3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)

Flow: Jupiter lite-api (`https://lite-api.jup.ag/swap/v1/quote` → `/swap/v1/swap`) → `@solana/web3.js` sign → RPC broadcast → on-chain confirmation.

---

## 0) Setup (30 seconds)

```bash
npm install
cp .env.example .env
```

Paper mode works out of the box — no RPC or keys needed.

---

## 1) Automated Demo (recommended)

```bash
bash scripts/demo-judge.sh
```

What it proves automatically:

| Step | What happens | What it proves |
|---|---|---|
| Register agent | Creates agent with `momentum-v1` strategy + API key | Agent identity & auth |
| Seed price ramp | Pushes 6 ascending SOL prices | Strategy signal generation |
| Submit valid trade | $80 paper buy → executed | End-to-end intent → execution flow |
| Submit risky trade | $300 buy (exceeds $150 limit) → rejected | Risk engine blocks unsafe trades |
| Retrieve receipt | Hash-chained execution receipt | Verifiable audit trail |
| Verify receipt | Deterministic hash re-check → `ok: true` | Tamper-evidence |
| Check treasury | Fee accrued from executed trade | Monetization works |
| Check risk telemetry | Drawdown, exposure, reject counters, cooldown | Full observability |

---

## 2) Manual Spot Checks (optional)

Start the server:

```bash
npm run build
node dist/index.js
```

In another terminal:

### Register an agent

```bash
curl -s -X POST http://localhost:8787/agents/register \
  -H 'content-type: application/json' \
  -d '{"name":"judge-manual","strategyId":"momentum-v1"}'
```

### Test idempotency (replay + conflict)

```bash
# First request
curl -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":80,"requestedMode":"paper"}'

# Same key, same payload → idempotent replay (returns same intent)
curl -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":80,"requestedMode":"paper"}'

# Same key, different payload → 409 Conflict
curl -i -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":120,"requestedMode":"paper"}'
```

### Risk telemetry

```bash
curl -s http://localhost:8787/agents/<AGENT_ID>/risk | node -e "process.stdin.pipe(process.stdout)"
```

Returns: drawdown %, gross exposure, daily PnL, reject counters by reason, cooldown state, agent limits.

### Execution receipt + verification

```bash
curl -s http://localhost:8787/executions/<EXECUTION_ID>/receipt
curl -s http://localhost:8787/receipts/verify/<EXECUTION_ID>
```

### Live dashboard

Open in browser: [http://localhost:8787/experiment](http://localhost:8787/experiment)

### Clawpump token revenue integration

```bash
curl -s http://localhost:8787/integrations/clawpump/health
curl -s 'http://localhost:8787/integrations/clawpump/earnings?agentId=<AGENT_ID>'
curl -s http://localhost:8787/integrations/clawpump/launch-attempts
```

Upstream degradation returns structured error responses (with status codes and action hints), not opaque 500s.

---

## 3) Test Suite

```bash
npm test   # 33 tests, all passing
```

Covers: risk engine, fee engine, receipt engine, strategy registry, idempotency (API-level), experiment dashboard, Clawpump wallet logic, Clawpump error mapping.

---

## 4) What Makes This Judge-Worthy

| Dimension | How we deliver |
|---|---|
| **Safety** | Multi-factor risk engine: position limits, order caps, exposure limits, daily loss cap, drawdown threshold, cooldown timer. Rejections are explicit and counted. |
| **Auditability** | SHA-256 hash-chained execution receipts with deterministic verification API. Append-only NDJSON event log. |
| **Monetization** | Three revenue streams: per-execution fee treasury, Jupiter platform referral fees, x402 payment gates. |
| **Reliability** | Idempotent intent ingestion prevents duplicate trades. Retry/backoff on Jupiter quote path. |
| **Extensibility** | Pluggable strategy registry. New strategies = one file + register. |
| **Proven** | Not a mockup — [live mainnet transaction](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf). |
