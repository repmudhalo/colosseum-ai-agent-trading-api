# Colosseum AI Agent Trading API

Autonomous, agent-facing trading API MVP for the Colosseum Agent Hackathon.

> **Theme fit:** AI agents + Solana execution + monetizable infra (fees + payment gate).

## 1) Problem

Most trading APIs are built for humans, not autonomous agents. Agents need:

- programmatic identity/registration
- async intent submission
- built-in risk limits (without babysitting)
- an always-on execution loop
- a clear business model for API operators

This project provides that baseline as a runnable MVP.

## 2) What this MVP includes

- REST API for:
  - agent registration
  - trade intent submission
  - portfolio/intents/execution queries
- Autonomous worker loop:
  - polls pending intents
  - runs risk engine
  - executes in paper mode (default)
  - optional live mode path through Jupiter
- Risk controls:
  - position sizing (% of equity)
  - max order notional
  - max gross exposure
  - daily loss cap
  - max drawdown guard
  - cooldown
- Fee monetization abstraction:
  - execution accounting fee in bps (captured in treasury ledger)
  - Jupiter referral plumbing (`platformFeeBps` + `feeAccount`)
- x402-compatible payment gate stub:
  - optional `402 Payment Required` gate on paid endpoints
- Persistent state + logs:
  - `data/state.json`
  - `data/events.ndjson`
- Health + metrics endpoints
- Graceful shutdown (`SIGINT`, `SIGTERM`)
- Unit tests for core risk + fee logic

## 3) Architecture

```text
Agents (API key)
   |
   v
Fastify REST API  ---- x402 payment gate (optional)
   |                              |
   | trade intents                 v
   +----------------------> payment denial metrics
   |
   v
Persistent State Store (JSON)
   |
   v
Execution Worker Loop (interval)
   |
   +--> RiskEngine (position sizing, exposure, DD, loss cap, cooldown)
   |
   +--> ExecutionService
          |- Paper execution accounting
          |- Optional Jupiter live route
          |- FeeEngine (platform fee + referral params)
   |
   v
Treasury ledger + metrics + event logs
```

### Key modules

- `src/api/routes.ts` — API surface
- `src/services/worker.ts` — autonomous execution loop
- `src/services/executionService.ts` — execution orchestration + accounting
- `src/domain/risk/riskEngine.ts` — risk policy engine
- `src/domain/fee/feeEngine.ts` — fee logic + Jupiter referral plumbing
- `src/services/paymentGate.ts` — x402-compatible gate stub
- `src/infra/storage/stateStore.ts` — persistent app state

## 4) Autonomy design

Flow per intent:

1. Agent submits trade intent (`pending`)
2. Worker claims it (`processing`)
3. Risk engine evaluates with current state + prices
4. If blocked -> `rejected` with reason
5. If approved -> execute (`paper` or `live`)
6. Update portfolio, treasury, metrics, and logs

This supports hands-off operation with safety defaults.

## 5) Solana/Jupiter integration approach

### Current MVP path

- Default mode: **paper**
- Optional mode: **live** (must set env vars)
- Live flow uses Jupiter APIs:
  - quote: `GET /v6/quote`
  - swap tx build: `POST /v6/swap`
- If signing key + RPC configured:
  - signs swap tx with `@solana/web3.js`
  - broadcasts only when `LIVE_BROADCAST_ENABLED=true`

### Env gates for live mode

- `LIVE_TRADING_ENABLED=true`
- `SOLANA_RPC_URL=<rpc>`
- `SOLANA_PRIVATE_KEY_B58=<private key>`

Without these, live requests are safely rejected.

## 6) Fee monetization model

Two complementary fee rails:

1. **Platform execution fee (implemented now):**
   - `PLATFORM_FEE_BPS` on notional
   - recorded in treasury ledger (`treasury.entries`)
2. **Jupiter referral path (plumbed):**
   - sends `platformFeeBps`
   - includes `feeAccount` when `JUPITER_REFERRAL_ACCOUNT` is set

Optional API monetization gate:

- **x402-compatible stub** can require payment proof on paid routes and return HTTP 402 if absent.

## 7) Local run

```bash
npm install
cp .env.example .env
npm run dev
```

Server starts on `http://localhost:8787` by default.

## 8) API quickstart

### Register agent

```bash
curl -s -X POST http://localhost:8787/agents/register \
  -H 'content-type: application/json' \
  -d '{"name":"alpha-agent"}' | jq
```

Save the returned `apiKey` and `agent.id`.

### Set price feed (paper)

```bash
curl -s -X POST http://localhost:8787/market/prices \
  -H 'content-type: application/json' \
  -d '{"symbol":"SOL","priceUsd":130}' | jq
```

### Submit trade intent

```bash
curl -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -d '{
    "agentId":"<AGENT_ID>",
    "symbol":"SOL",
    "side":"buy",
    "notionalUsd":250,
    "requestedMode":"paper"
  }' | jq
```

### Check status

```bash
curl -s http://localhost:8787/metrics | jq
curl -s http://localhost:8787/health | jq
```

## 9) Demo script (hackathon-friendly)

A scripted demo is included:

```bash
bash scripts/demo.sh
```

It will:

1. start from clean state
2. register an agent
3. set market price
4. submit buy + sell intents
5. print portfolio + metrics + treasury fees

## 10) Tests

```bash
npm test
```

Includes:

- risk engine policy tests
- fee engine monetization tests

## 11) Notes

- This MVP intentionally keeps persistence simple (JSON store) for hackathon speed.
- Upgrade path: Postgres/Redis queue, stronger auth, richer order types, true multi-venue routing.
