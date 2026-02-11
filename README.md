# Colosseum AI Agent Trading API (v3)

Autonomous, agent-facing trading API upgraded for Colosseum judging.

## What is new in v3

### 1) Verifiable execution receipts (judge-facing trust primitive)

- Deterministic receipt hash per execution
- Hash chaining via previous receipt hash
- Signature payload for independent verification
- API endpoints:
  - `GET /executions/:executionId/receipt`
  - `GET /receipts/verify/:executionId`

### 2) Risk telemetry endpoint (standardized observability)

- API endpoints:
  - `GET /agents/:agentId/risk`
  - `GET /agents/:agentId/risk-telemetry` (alias)
- Metrics include:
  - drawdown
  - gross exposure
  - realized + daily pnl
  - reject counters (agent + global)
  - cooldown state

### 3) Strategy plugin interface + switchable per-agent strategy

- Plugin registry in `src/domain/strategy/`
- Included strategies:
  - `momentum-v1`
  - `mean-reversion-v1`
- Agent strategy change:
  - `PATCH /agents/:agentId/strategy`
- Strategy catalog:
  - `GET /strategies`

### 4) Production hardening

- Trade intent idempotency:
  - `x-idempotency-key` / `idempotency-key`
- Live quote retry/backoff
- Structured error taxonomy (`src/errors/taxonomy.ts`)

### 5) Monetization polish

- x402 policy file: `config/x402-policy.json`
- Policy-aware gate middleware
- Policy endpoint: `GET /paid-plan/policy`
- Paid policy details also surfaced in `/metrics`

---

## Quick local run

```bash
npm install
cp .env.example .env
npm run dev
```

Default base URL: `http://localhost:8787`

## 2-minute judging demo

```bash
bash scripts/demo-judge.sh
```

This demonstrates in one run:
- risk rejection
- successful execution
- receipt retrieval + verification
- fee accrual in treasury

See `docs/JUDGES.md` for exact manual curl commands.

---

## Colosseum-skill compliance artifacts

- `docs/COLOSSEUM_WORKFLOW.md` — project create/update/submit + forum/vote cadence
- `docs/HEARTBEAT_INTEGRATION_NOTES.md` — heartbeat integration plan
- `docs/COLOSSEUM_SKILL_CHECKLIST.md` — requirement mapping + blockers

---

## Tests

```bash
npm test
```

Covers:
- risk and fee engines
- receipt hashing/verification
- strategy behavior
- idempotency behavior (service + API)
