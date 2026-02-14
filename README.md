# Sesame

> Autonomous Solana meme coin trading arm with self-learning.

Sesame is the trading execution layer that plugs into your agent (e.g., OpenClaw). Send it a token contract address, and it handles everything: buy via Jupiter DEX, auto take-profit, stop-loss, trailing stop, moon bags, dip re-entries, and learning from every trade to get smarter over time.

## How It Works

```
Your Bot (OpenClaw)          Sesame (this API)
     │                            │
     │  POST /snipe               │
     │  { mint, 0.05 SOL }  ───► │  Buy via Jupiter DEX
     │                            │  Track position
     │                            │  Monitor price every 10s
     │                            │  ┌─ Take Profit (+30%)  → sell 80%, keep 20% moon bag
     │                            │  ├─ Stop Loss (-15%)     → full sell
     │                            │  ├─ Trailing Stop (-20%) → full sell
     │                            │  └─ Dip Re-Entry (-25%)  → auto buy back in
     │                            │
     │  GET /snipe/portfolio      │  ← Live prices, P&L, strategy status
     │                            │
     │                            │  Learning service analyzes every trade
     │                            │  Adapts strategy based on performance
```

## Quick Start

```bash
# Install
npm install

# Configure (add your Solana RPC + private key)
cp .env.example .env

# Run
npm run dev
```

## Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/snipe` | Buy or sell any token by mint address |
| `POST` | `/snipe/analyze` | Check liquidity before buying |
| `GET` | `/snipe/portfolio` | All positions with live prices + P&L |
| `GET` | `/snipe/strategy` | View default exit strategy |
| `PUT` | `/snipe/strategy` | Override default strategy |
| `PUT` | `/snipe/positions/{mint}/strategy` | Override strategy for one position |
| `GET` | `/snipe/trades` | Trade history (includes auto-exits) |
| `GET` | `/snipe/wallet` | Wallet status |
| `POST` | `/charts/capture` | Manually capture a chart screenshot |
| `GET` | `/charts` | List all chart captures |
| `GET` | `/charts/image/{filename}` | Serve a chart PNG |
| `POST` | `/charts/upload` | Upload a reference chart (base64) |

## Default Strategy

| Parameter | Default | What It Does |
|-----------|---------|--------------|
| Take Profit | +30% | Sell when price rises 30% above entry |
| Stop Loss | -15% | Sell when price drops 15% below entry |
| Trailing Stop | -20% | Sell when price drops 20% from its peak |
| Moon Bag | 20% | Keep 20% of tokens on TP (ride further upside) |
| Re-Entry | -25% | Auto buy back when price dips 25% from TP sell |
| Re-Entry Amount | 0.01 SOL | SOL per re-entry buy |
| Max Re-Entries | 2 | Maximum dip buys per token |

All configurable via `.env`, API, or per-trade.

## Features

- **Direct Token Trading** — Buy/sell any Solana SPL token by mint address via Jupiter DEX
- **Auto Exit Management** — TP, SL, trailing stop run automatically in the background
- **Moon Bags** — Partial sell on TP, keep a % riding with trailing stop only
- **Dip Re-Entry** — After TP, auto-buy back when price dips
- **Position Tracking** — Live prices, entry/peak/current, P&L per position
- **Persistence** — Positions, trades, strategy survive server restarts
- **Self-Learning** — Analyzes trade patterns, adapts strategy based on performance
- **Bot Integration** — Clean REST API designed for AI agent consumption
- **Strategy Override** — Bot can override TP/SL/trailing per trade or per position

## Self-Learning Pipeline

Every snipe trade feeds into the learning engine:

1. **Trade patterns** — Win rate, profit factor, expectancy per token
2. **Market regime** — Trending, ranging, or volatile detection
3. **Adaptive tuning** — Auto-adjusts TP/SL/moon bag based on recent results
4. **Knowledge base** — Persisted to disk, builds over time

View learning metrics: `GET /agents/snipe-bot/learning/metrics`

## Production URL

```
https://timmy-agent-trading-api-production.up.railway.app
```

## Deployment (Railway)

```bash
# Push to your repo, then on Railway:
# 1. Connect your GitHub repo
# 2. Set environment variables (see .env.example)
# 3. Deploy — Railway uses the Dockerfile automatically
# Data persists via a mounted volume at /app/data (configured in railway.toml)
```

Key env vars for Railway:
- `SOLANA_RPC_URL` — Your Helius/QuickNode RPC
- `SOLANA_PRIVATE_KEY_B58` — Trading wallet private key (base58)
- `DEFAULT_MODE=live`
- `LIVE_TRADING_ENABLED=true`
- `LIVE_BROADCAST_ENABLED=true`

## Tech Stack

- **Runtime:** Node.js 22 + TypeScript
- **Framework:** Fastify
- **DEX:** Jupiter (Solana)
- **Prices:** DexScreener API
- **Persistence:** JSON file-based (data/)
- **Deployment:** Railway (Docker)

## License

MIT
