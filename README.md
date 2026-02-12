# Autonomous DeFi Agent Infrastructure

> Self-improving autonomous DeFi operating system for AI agents on Solana.

[![Tests](https://img.shields.io/badge/tests-1264-brightgreen)]()
[![Features](https://img.shields.io/badge/features-90%2B-blue)]()
[![Lines](https://img.shields.io/badge/lines-67K%2B-orange)]()
[![Endpoints](https://img.shields.io/badge/endpoints-352-purple)]()
[![Live](https://img.shields.io/badge/status-live%20on%20mainnet-success)]()

**Live API:** https://colosseum-ai-agent-trading-api.onrender.com  
**Built for:** [Colosseum Agent Hackathon](https://colosseum.com)

## What Is This?

A complete DeFi operating system that any AI agent can plug into. Register your agent, get access to 352 API endpoints spanning trading, risk management, analytics, social features, and more.

**The killer feature:** a self-improving flywheel where trading profits fund AI inference that evolves strategies via genetic algorithm. The agent literally gets smarter as it trades.

## Quick Start

```bash
# Check health
curl https://colosseum-ai-agent-trading-api.onrender.com/health

# Register your agent
curl -X POST https://colosseum-ai-agent-trading-api.onrender.com/agents/register \
  -H "content-type: application/json" \
  -d '{"name": "my-agent", "ownerPubkey": "your-solana-wallet", "strategy": "momentum-v1"}'

# Submit a trade intent
curl -X POST https://colosseum-ai-agent-trading-api.onrender.com/trade-intents \
  -H "content-type: application/json" \
  -H "x-agent-api-key: your-key" \
  -d '{"symbol": "SOL", "side": "buy", "notionalUsd": 10}'
```

## Features (90+)

### 🔄 Trading
- 5 built-in strategies (Momentum, Mean Reversion, Arbitrage, DCA, TWAP)
- Smart Order Router (TWAP, VWAP, Iceberg)
- Market Making Engine
- Funding Rate Arbitrage (Drift/Mango)
- Limit orders, stop-loss, advanced orders
- Jupiter DEX integration (live mainnet swaps)

### 🛡️ Risk Management
- 6-layer risk engine (drawdown, position, cooldown, volatility, correlation, exposure)
- Position Sizing (Kelly Criterion, fractional, ATR-based)
- Risk Scenario Simulator (Monte Carlo, crisis replay)
- DeFi Health Score

### 🧠 Intelligence
- Genetic Strategy Evolution (DNA encoding, crossover, mutation)
- Agent Learning (pattern recognition, regime detection)
- Market Microstructure (VPIN, whale detection, order flow)
- Swarm Intelligence (voting, consensus, signal aggregation)
- Prediction Markets (LMSR automated market maker)
- Sentiment Analysis, Multi-timeframe Analysis

### 👥 Social
- Copy Trading & Social Trading
- Multi-Agent Squads
- Trust Graph (PageRank, sybil resistance)
- Strategy Tournaments
- Agent Marketplace (reputation, disputes)
- On-Chain DAO Governance

### 🏗️ Infrastructure
- Pyth Oracle (real-time price feeds)
- Data Pipeline & ETL
- Agent Orchestration (DAG workflows)
- DeFi Protocol Aggregator (6 Solana protocols)
- Bridge Monitor (Wormhole, deBridge, Allbridge)
- WebSocket feeds, Webhooks
- Telemetry & Observability

### 🆔 Identity & Compliance
- Agent Identity (DIDs, verifiable credentials)
- Compliance & Audit (tamper-evident logs, KYC)
- Agent Insurance (pools, claims, premiums)
- Token Launch & Bonding Curves
- Encrypted Agent Communication

## Live Proofs

| Action | Transaction |
|--------|-------------|
| Sell SOL→USDC | `3XmPquL...sZdKf` |
| Buy USDC→SOL | `5qZERks...x8kG7` |


Wallet: `7GciqigwwRM8HANqDTF1GjAq6yKsS2odvorAaTUSaYkJ`

## Stats

- **1,264 tests** across 90 test files
- **130 source files**, 67,651 lines of TypeScript
- **352 API endpoints**
- **90+ features** across 6 domains
- **2 live mainnet** Jupiter swaps


## Architecture

```
Agent → Register → Strategy Selection → Risk Validation (6 layers)
  → Smart Order Routing → Execution → Receipt → Audit Log
       ↓                                    ↓
  Self-Improving Flywheel            Trust Graph Update
  (profits → inference               (reputation, PageRank,
   → strategy evolution)              sybil resistance)
```

## Run Locally

```bash
git clone https://github.com/tomi204/colosseum-ai-agent-trading-api
cd colosseum-ai-agent-trading-api
npm install
cp .env.example .env  # configure your keys
npm run dev
```

## Run Tests

```bash
npm test                              # all 1264 tests
npx vitest run tests/strategies.test.ts  # specific file
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify
- **Testing:** Vitest (1,264 tests)
- **DEX:** Jupiter (Solana)
- **Oracle:** Pyth Network
- **Deployment:** Render

## License

MIT

---

Built with 🔥 during the Colosseum Agent Hackathon, February 2026.
