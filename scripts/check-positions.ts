/**
 * Check token positions — calls the Sesame API and prints a summary of
 * open positions, wallet status, and watched-for-reentry tokens.
 *
 * Usage:
 *   npx tsx scripts/check-positions.ts
 *   BASE_URL=https://your-api.up.railway.app npx tsx scripts/check-positions.ts
 *
 * Uses .env if present (BASE_URL or default to production).
 */

import 'dotenv/config';

const BASE_URL = process.env.BASE_URL ?? 'https://timmy-agent-trading-api-production.up.railway.app';

async function main() {
  console.log('Sesame — Token positions check\n');
  console.log(`API: ${BASE_URL}\n`);

  try {
    const [walletRes, portfolioRes] = await Promise.all([
      fetch(`${BASE_URL}/snipe/wallet`),
      fetch(`${BASE_URL}/snipe/portfolio`),
    ]);

    if (!walletRes.ok) {
      console.error('Wallet:', walletRes.status, await walletRes.text());
      process.exit(1);
    }
    if (!portfolioRes.ok) {
      console.error('Portfolio:', portfolioRes.status, await portfolioRes.text());
      process.exit(1);
    }

    const wallet = (await walletRes.json()) as {
      ready: boolean;
      walletAddress: string | null;
      broadcastEnabled: boolean;
    };
    const portfolio = (await portfolioRes.json()) as {
      openPositions: Array<{
        mintAddress: string;
        symbol?: string | null;
        name?: string | null;
        tokensHeld: string;
        tokenDecimals: number;
        entryPriceUsd: number | null;
        currentPriceUsd: number | null;
        currentValueUsd: number | null;
        changePct: number | null;
        changeFromPeakPct: number | null;
        exitStrategy: { takeProfitPct: number; stopLossPct: number; trailingStopPct: number | null; moonBagPct: number };
        isMoonBag: boolean;
        status: string;
      }>;
      watchedForReEntry: Array<{
        mintAddress: string;
        symbol?: string | null;
        name?: string | null;
        sellPriceUsd: number;
        reEntryBelow: number;
        remainingReEntries: number;
      }>;
      totalSolSpent: number;
      totalRealizedPnlSol: number;
      totalOpenValueUsd: number | null;
      totalTrades: number;
      priceMonitorActive: boolean;
      priceMonitorIntervalSec: number;
    };

    console.log('── Wallet ─────────────────────────────────────────────');
    console.log('  Ready:', wallet.ready);
    console.log('  Address:', wallet.walletAddress ?? '—');
    console.log('  Broadcast enabled:', wallet.broadcastEnabled);
    console.log('');

    console.log('── Price monitor ──────────────────────────────────────');
    console.log('  Active:', portfolio.priceMonitorActive);
    console.log('  Interval:', portfolio.priceMonitorIntervalSec, 'sec');
    console.log('');

    console.log('── Open positions ─────────────────────────────────────');
    if (portfolio.openPositions.length === 0) {
      console.log('  (none)');
    } else {
      for (const p of portfolio.openPositions) {
        const label = [p.symbol, p.name].filter(Boolean).join(' / ') || p.mintAddress.slice(0, 8) + '…';
        const tokens = Number(p.tokensHeld) / 10 ** p.tokenDecimals;
        console.log(`  ${label}`);
        console.log(`    Mint:    ${p.mintAddress}`);
        console.log(`    Tokens:  ${tokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} (raw: ${p.tokensHeld})`);
        console.log(`    Entry:   $${p.entryPriceUsd ?? '—'}`);
        console.log(`    Current: $${p.currentPriceUsd ?? '—'}  (value $${p.currentValueUsd ?? '—'})`);
        console.log(`    Change:  ${p.changePct != null ? p.changePct.toFixed(1) + '%' : '—'} from entry, ${p.changeFromPeakPct != null ? p.changeFromPeakPct.toFixed(1) + '%' : '—'} from peak`);
        console.log(`    TP: +${p.exitStrategy.takeProfitPct}%  SL: -${p.exitStrategy.stopLossPct}%  Trailing: ${p.exitStrategy.trailingStopPct ?? 'off'}%  Moon: ${p.exitStrategy.moonBagPct}%`);
        console.log(`    Moon bag: ${p.isMoonBag}  Status: ${p.status}`);
        console.log('');
      }
    }

    console.log('── Watched for re-entry ───────────────────────────────');
    if (portfolio.watchedForReEntry.length === 0) {
      console.log('  (none)');
    } else {
      for (const w of portfolio.watchedForReEntry) {
        const label = [w.symbol, w.name].filter(Boolean).join(' / ') || w.mintAddress.slice(0, 8) + '…';
        console.log(`  ${label}  sell $${w.sellPriceUsd}  re-entry below $${w.reEntryBelow.toFixed(10)}  remaining: ${w.remainingReEntries}`);
      }
    }
    console.log('');

    console.log('── Summary ─────────────────────────────────────────────');
    console.log('  Total SOL spent:     ', portfolio.totalSolSpent);
    console.log('  Total realized PnL:  ', portfolio.totalRealizedPnlSol, 'SOL');
    console.log('  Total open value:   ', portfolio.totalOpenValueUsd != null ? `$${portfolio.totalOpenValueUsd}` : '—');
    console.log('  Total trades:       ', portfolio.totalTrades);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
