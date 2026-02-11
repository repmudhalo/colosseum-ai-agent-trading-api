# 🏛️ Colosseum AI Agent Trading API

**Safe, auditable, monetizable trading infrastructure for autonomous AI agents on Solana.**

[![Tests](https://img.shields.io/badge/tests-33%20passing-brightgreen)](#tests)
[![Live on Mainnet](https://img.shields.io/badge/mainnet-proven-blue)](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](#license)

---

## The Problem

AI agents are entering DeFi at scale, but existing trading infrastructure isn't built for them:

| Challenge | What happens today |
|---|---|
| **No guardrails** | Agents can blow up a portfolio in seconds — no drawdown limits, no cooldowns, no exposure caps |
| **No audit trail** | Trades vanish into opaque execution — no verifiable proof of what happened or why |
| **No monetization** | Operators have no built-in way to earn from agents using their infrastructure |
| **No idempotency** | Network retries cause duplicate trades, silent position drift |

This project solves all four.

---

## The Solution

A self-contained trading API designed from the ground up for AI agents. Agents register, submit trade intents, and the system handles risk enforcement, execution, receipt generation, and fee collection — autonomously.

**Proven on Solana mainnet:** [`3XmPquL...sZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        AI AGENT CLIENTS                         │
│              (any LLM agent, bot, or automation)                │
└────────────────────────────┬─────────────────────────────────────┘
                             │  POST /trade-intents
                             │  x-agent-api-key + x-idempotency-key
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                     FASTIFY API GATEWAY                          │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ x402 Payment│  │ Idempotency  │  │   Agent Auth            │ │
│  │ Gate        │  │ Guard        │  │   (API key validation)  │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
┌──────────────────┐ ┌─────────────┐ ┌──────────────────┐
│ STRATEGY ENGINE  │ │ RISK ENGINE │ │ EXECUTION WORKER │
│                  │ │             │ │                  │
│ • momentum-v1   │ │ • Position  │ │ • Async queue    │
│ • mean-rev-v1   │ │ • Drawdown  │ │ • Paper fills    │
│ • pluggable     │ │ • Exposure  │ │ • Live Jupiter   │
│                  │ │ • Cooldown  │ │   swap execution │
└──────────────────┘ │ • Daily cap │ └────────┬─────────┘
                     └─────────────┘          │
                                              ▼
                                   ┌─────────────────────┐
                                   │   RECEIPT ENGINE     │
                                   │                      │
                                   │ • SHA-256 hash chain │
                                   │ • Deterministic      │
                                   │   verification       │
                                   │ • Tamper-evident      │
                                   └──────────┬────────────┘
                                              │
              ┌───────────────────────────────┼───────────────┐
              ▼                               ▼               ▼
┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   FEE ENGINE         │ │  EVENT LOGGER    │ │  CLAWPUMP        │
│   (treasury accrual) │ │  (NDJSON audit)  │ │  (token revenue) │
└──────────────────────┘ └──────────────────┘ └──────────────────┘
```

---

## Feature Matrix

| Feature | Status | Details |
|---|---|---|
| **Agent Registration** | ✅ Working | Per-agent API keys, capital tracking, strategy assignment |
| **Trade Intent Queue** | ✅ Working | Async intent submission with autonomous worker processing |
| **Idempotent Ingestion** | ✅ Working | `x-idempotency-key` header — replay returns same result, conflict returns 409 |
| **Risk Engine** | ✅ Working | Max position size, max order notional, gross exposure cap, daily loss limit, drawdown threshold, cooldown timer |
| **Risk Telemetry** | ✅ Working | Real-time drawdown %, exposure, PnL, reject counters by reason, cooldown state |
| **Strategy Plugins** | ✅ Working | `momentum-v1` (trend-following), `mean-reversion-v1` (contrarian) — pluggable registry |
| **Paper Trading** | ✅ Working | Zero-risk simulation fills at market price |
| **Live Jupiter Swaps** | ✅ Proven | Jupiter lite-api quote → swap → sign → broadcast ([mainnet tx proof](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)) |
| **Execution Receipts** | ✅ Working | SHA-256 hash-chained, deterministic, verifiable via API |
| **Fee Monetization** | ✅ Working | Per-execution fee accrual into operator treasury + Jupiter referral fee plumbing |
| **x402 Payment Gate** | ✅ Working | Configurable HTTP 402 paywall for premium endpoints |
| **Clawpump Integration** | ✅ Working | Token launch, earnings queries, structured error mapping for degraded upstream |
| **Live Dashboard** | ✅ Working | `/experiment` — real-time HTML dashboard of agents, intents, executions, risk state |
| **Event Audit Log** | ✅ Working | Append-only NDJSON log of all system events |
| **Test Suite** | ✅ 33 tests | Risk, fees, receipts, strategies, idempotency, dashboard, Clawpump wallet/error mapping |

---

## Live Transaction Proof

This API has executed a real swap on Solana mainnet via Jupiter:

> **TX:** [`3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)

The live flow: Jupiter lite-api quote → swap instruction → Solana `@solana/web3.js` sign → RPC broadcast → on-chain confirmation.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/<your-org>/colosseum-ai-agent-trading-api.git
cd colosseum-ai-agent-trading-api
npm install

# Configure (paper mode works out of the box)
cp .env.example .env

# Build and run
npm run build
node dist/index.js
# → Listening on http://localhost:8787

# Or use dev mode with hot reload
npm run dev
```

### Run the Judge Demo (recommended)

```bash
bash scripts/demo-judge.sh
```

This single script proves in one run:
1. ✅ Agent registration with strategy assignment
2. ✅ Successful trade execution (paper fill)
3. ✅ Risk rejection of an oversized order
4. ✅ Execution receipt retrieval + hash chain verification
5. ✅ Fee accrual into operator treasury
6. ✅ Risk telemetry with drawdown, exposure, reject counters, cooldown state

### Run the Test Suite

```bash
npm test    # 33 tests, all passing
```

---

## API Reference

### Core Trading

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/agents/register` | Register a new agent (returns agent ID + API key) |
| `PATCH` | `/agents/:agentId/strategy` | Change agent's strategy plugin |
| `POST` | `/trade-intents` | Submit a trade intent (requires `x-agent-api-key`, supports `x-idempotency-key`) |
| `GET` | `/trade-intents/:intentId` | Poll intent status (`pending` → `executed` / `rejected` / `failed`) |
| `GET` | `/executions` | List all execution records |
| `POST` | `/market/prices` | Seed market price data (for strategy signals and paper fills) |

### Trust & Verification

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/executions/:executionId/receipt` | Retrieve the hash-chained execution receipt |
| `GET` | `/receipts/verify/:executionId` | Verify receipt integrity (payload hash + chain hash + signature payload) |

### Risk & Observability

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/agents/:agentId/risk` | Real-time risk telemetry (drawdown, exposure, PnL, reject counters, cooldown) |
| `GET` | `/metrics` | System metrics + treasury fee totals |
| `GET` | `/experiment` | Live HTML dashboard — agents, intents, executions, risk state |

### Monetization & Policy

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/paid-plan/policy` | x402 payment policy (which endpoints require payment) |

### Token Revenue (Clawpump Integration)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/integrations/clawpump/health` | Upstream health check |
| `GET` | `/integrations/clawpump/earnings?agentId=...` | Query agent token earnings |
| `POST` | `/integrations/clawpump/launch` | Launch a new token |
| `GET` | `/integrations/clawpump/launch-attempts` | List launch attempt history |

---

## Why This Wins

### 1. Safety-First by Design
Every trade intent passes through a multi-layer risk engine before execution: position size limits, order notional caps, gross exposure limits, daily loss caps, max drawdown thresholds, and cooldown timers. Risk rejections are explicit, auditable, and counted. **An agent physically cannot blow up a portfolio.**

### 2. Verifiable Execution Receipts
Every execution produces a SHA-256 hash-chained receipt. Each receipt links to the previous one, creating a tamper-evident audit chain. Anyone can verify any execution's integrity via the API. This is not a concept — it's running and testable right now.

### 3. Built for Agents, Not Humans
No UI-first thinking. Every interaction is API-native: register with a POST, trade with a POST, verify with a GET. Idempotency keys prevent duplicate trades from network retries. Strategies are plugins, not hardcoded. Agents are first-class citizens with their own API keys, capital accounts, and risk profiles.

### 4. Three Revenue Streams
Operators earn from: (a) per-execution fee accrual into treasury, (b) Jupiter platform referral fees on live swaps, (c) x402 HTTP payment gates on premium endpoints. Revenue is tracked, auditable, and extensible.

### 5. Proven on Mainnet
Not a mockup. The Jupiter integration has executed a real swap on Solana mainnet with a confirmed transaction signature. The architecture bridges paper trading for safe development to live execution for production.

### 6. 33 Tests, Zero Handwaving
Risk engine, fee engine, receipt engine, strategy registry, idempotency, experiment dashboard, Clawpump integration — all covered by automated tests that pass right now.

---

## Project Structure

```
src/
├── api/            # Fastify routes + experiment dashboard
├── domain/
│   ├── fee/        # Fee calculation engine
│   ├── receipt/    # SHA-256 hash-chained receipt generation
│   ├── risk/       # Multi-factor risk engine
│   └── strategy/   # Pluggable strategy registry (momentum, mean-reversion)
├── services/       # Agent, execution, intent, worker, payment gate, token revenue
├── integrations/   # Clawpump token revenue client
├── infra/          # State persistence + event logger
├── types.ts        # Full type definitions
└── config.ts       # Environment-driven configuration
```

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify
- **Blockchain:** Solana (`@solana/web3.js`)
- **DEX Routing:** Jupiter lite-api (`jup.ag`)
- **Validation:** Zod
- **Testing:** Vitest
- **Persistence:** JSON state file + NDJSON event log

---

## Documentation

- [`docs/JUDGES.md`](docs/JUDGES.md) — 2-minute judge walkthrough
- [`docs/RECEIPTS.md`](docs/RECEIPTS.md) — Execution receipt specification
- [`docs/HACKATHON_SUBMISSION.md`](docs/HACKATHON_SUBMISSION.md) — Submission context

---

## License

MIT
