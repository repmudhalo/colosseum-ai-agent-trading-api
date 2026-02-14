# Sesame — Solana Meme Coin Trading Arm

You are connected to **Sesame**, a live Solana trading arm that buys/sells any SPL token via Jupiter DEX. Sesame **automatically manages** your positions: take profit, stop loss, trailing stop, moon bags, and dip re-entries.

## Base URL

```
https://timmy-agent-trading-api-production.up.railway.app
```

## Core Workflow

1. **Analyze** a token (check liquidity)
2. **Buy** by sending the mint address
3. The **trading arm handles everything** — TP, SL, trailing, moon bag, re-entry
4. Optionally **override strategy** on any position at any time
5. Check **trade history** to see auto-exits and re-entries

## API Endpoints

### Buy a Token

```
POST /snipe
Content-Type: application/json

{
  "mintAddress": "THE_TOKEN_MINT_ADDRESS",
  "side": "buy",
  "amountSol": 0.05,
  "slippageBps": 300,
  "tag": "reason-for-trade",
  "strategy": {
    "takeProfitPct": 50,
    "stopLossPct": 10,
    "trailingStopPct": 15,
    "moonBagPct": 25,
    "reEntryEnabled": true,
    "reEntryDipPct": 20,
    "reEntryAmountSol": 0.01,
    "maxReEntries": 3
  }
}
```

**Parameters:**
- `mintAddress` (required): Solana SPL token mint address (32-44 char base58)
- `side`: `"buy"` or `"sell"`
- `amountSol` (required): SOL to spend
- `slippageBps` (optional): Slippage in bps. Default 300 (3%). Max 1500.
- `tag` (optional): Label for why you made this trade
- `strategy` (optional): Override defaults for this trade:
  - `takeProfitPct`: Sell at +X% from entry
  - `stopLossPct`: Sell at -X% from entry
  - `trailingStopPct`: Sell at -X% from peak. `null` to disable
  - `moonBagPct`: Keep X% of tokens on TP (0 = sell all, 20 = keep 20%)
  - `reEntryEnabled`: Auto dip-buy after TP
  - `reEntryDipPct`: Buy back when price drops X% from sell price
  - `reEntryAmountSol`: SOL per re-entry buy
  - `maxReEntries`: Max re-entries (0 = unlimited)

### Sell a Token (Manual)

Same endpoint, `"side": "sell"`. Use when you want to manually exit.

```
POST /snipe
{ "mintAddress": "...", "side": "sell", "amountSol": 0.05, "slippageBps": 500 }
```

### Analyze (No Trade)

```
POST /snipe/analyze
{ "mintAddress": "...", "amountSol": 0.01 }
```

If `hasLiquidity` is `false`, do NOT buy.

### Portfolio

```
GET /snipe/portfolio
```

**Response includes:**
```json
{
  "openPositions": [{
    "mintAddress": "...",
    "entryPriceUsd": 0.000024,
    "peakPriceUsd": 0.000030,
    "currentPriceUsd": 0.000028,
    "changePct": 16.67,
    "changeFromPeakPct": -6.67,
    "exitStrategy": { "takeProfitPct": 30, "moonBagPct": 20, "..." : "..." },
    "isMoonBag": false,
    "reEntryCount": 0,
    "status": "open"
  }],
  "watchedForReEntry": [{
    "mintAddress": "...",
    "sellPriceUsd": 0.000032,
    "reEntryBelow": 0.000024,
    "remainingReEntries": 2
  }],
  "defaultStrategy": { "..." : "..." }
}
```

### Strategy Management

**View default strategy:**
```
GET /snipe/strategy
```

**Update default strategy (future trades):**
```
PUT /snipe/strategy
{ "takeProfitPct": 40, "moonBagPct": 25, "reEntryDipPct": 30 }
```

**Override strategy for one position:**
```
PUT /snipe/positions/{mintAddress}/strategy
{ "takeProfitPct": 100, "stopLossPct": 5, "moonBagPct": 0 }
```

### Other Endpoints

```
GET /snipe/positions          — All open positions
GET /snipe/positions/{mint}   — Single position
GET /snipe/trades             — Trade history (includes auto-exits + re-entries)
GET /snipe/trades?mint={mint}&limit=20
GET /snipe/wallet             — Wallet status
```

### Chart Screenshots

Sesame auto-captures TradingView chart screenshots (via DexScreener) on every buy, sell, and auto-exit.

```
POST /charts/capture          — Manual chart capture
  Body: { "mintAddress": "...", "tag": "optional note" }

GET  /charts                  — List all captures
  Query: ?mint={mint}&trigger=buy&limit=50

GET  /charts/image/{filename} — Serve a chart PNG image

POST /charts/upload           — Upload a reference "good looking" chart
  Body: { "mintAddress": "...", "image": "base64png", "tag": "good entry" }
```

Charts are stored with metadata (price at capture, entry price, % change, trigger reason).
Use `/charts/upload` to add your own "reference" charts so Sesame can compare patterns.

## How Auto-Management Works

### Take Profit with Moon Bag

When price hits TP:
1. Sells **(100 - moonBagPct)%** of tokens (e.g., 80%)
2. Keeps **moonBagPct%** as a "moon bag" (e.g., 20%)
3. Moon bag stays open — **no TP ceiling** (lets it ride)
4. Moon bag keeps **SL and trailing stop** for downside protection
5. Trade history shows: `tag: "auto-tp-partial(80%_sold,20%_moon_bag)"`

### Dip Re-Entry

After taking profit (if `reEntryEnabled`):
1. Adds token to **watch list** with the sell price
2. Keeps polling DexScreener for the price
3. When price drops **reEntryDipPct%** below sell price → **auto-buys back in**
4. Re-entry uses `reEntryAmountSol` with fresh entry price and strategy
5. `maxReEntries` limits how many times this repeats per token

### Stop Loss / Trailing Stop

- **Stop loss**: Full sell when price drops SL% below entry
- **Trailing stop**: Full sell when price drops trailing% from its peak
- No moon bag on SL/trailing — exits completely

## Default Strategy

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `takeProfitPct` | 30 | Sell at +30% from entry |
| `stopLossPct` | 15 | Sell at -15% from entry |
| `trailingStopPct` | 20 | Sell at -20% from peak |
| `moonBagPct` | 20 | Keep 20% of tokens on TP |
| `reEntryEnabled` | true | Auto dip-buy after TP |
| `reEntryDipPct` | 25 | Re-enter at -25% from sell |
| `reEntryAmountSol` | 0.01 | 0.01 SOL per re-entry |
| `maxReEntries` | 2 | Max 2 re-entries per token |

## Trading Rules

1. **Always analyze before buying.** Only buy if `hasLiquidity` is `true`.
2. **Use small amounts.** 0.01-0.05 SOL per trade.
3. **Trust the auto-manager.** It handles TP, SL, moon bags, and re-entries.
4. **Override when needed.** Use the strategy endpoints to adjust per-position.
5. **Check trade history.** `GET /snipe/trades` shows auto-exits, moon bags, and re-entries.
6. **Always tag trades.** Helps track strategy performance.
7. **Set moonBagPct to 0** if you want clean full exits on TP.
8. **Set reEntryEnabled to false** if you don't want auto dip-buys.

## Example Full Cycle

```
1. Buy:     POST /snipe { "mintAddress": "ABC...", "side": "buy", "amountSol": 0.03 }
   → Position open. TP=30%, SL=15%, trailing=20%, moonBag=20%, reEntry=true

2. Price pumps +32%...
   → Auto-TP fires: sells 80%, keeps 20% moon bag
   → Trade: "auto-tp-partial(80%_sold,20%_moon_bag)"
   → Token added to re-entry watch list

3. Moon bag still open, riding with trailing stop only...

4. Price dips -25% from TP sell price...
   → Auto re-entry: buys 0.01 SOL worth at the dip
   → Trade: "auto-reentry(dip:-25.3%_from_tp_sell)"
   → Fresh position with fresh TP/SL/trailing

5. Price pumps again...
   → Cycle repeats (up to maxReEntries times)
```

## Error Handling

- `"No liquidity found"` — No Jupiter routes. Skip it.
- `"Swap failed: ..."` — On-chain failure. Try higher slippage.
- `"Invalid mint address format"` — Bad address.
- `"Snipe service not ready"` — Server not configured.
