/**
 * Snipe Service — Direct token trading with auto exit management.
 *
 * Features:
 *   - Buy any token by mint address via Jupiter DEX
 *   - Auto take-profit / stop-loss / trailing stop
 *   - Moon bag: keep a % of tokens on TP to ride further upside
 *   - Re-entry: auto-buy back on dips after taking profit
 *   - Full position + trade history tracking
 *   - Bot can override any strategy param at any time
 *
 * Flow: buy → monitor → partial TP (moon bag) → re-enter on dip → repeat
 */

import { v4 as uuid } from 'uuid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../config.js';
import { JupiterClient, JupiterQuoteResponse } from '../infra/live/jupiterClient.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Exit strategy for a position. Controls when/how the trading arm auto-sells. */
export interface ExitStrategy {
  /** Take profit: sell when price rises this % above entry. e.g., 30 = +30%. */
  takeProfitPct: number;
  /** Stop loss: sell when price drops this % below entry. e.g., 15 = -15%. */
  stopLossPct: number;
  /** Trailing stop: sell when price drops this % from its peak. Null = disabled. */
  trailingStopPct: number | null;

  // ─── Moon bag ──────────────────────────────────────────────────────
  /** % of tokens to KEEP on take-profit. 0 = sell everything (default). 20 = keep 20%. */
  moonBagPct: number;

  // ─── Re-entry ─────────────────────────────────────────────────────
  /** Enable auto dip-buy after taking profit. */
  reEntryEnabled: boolean;
  /** Buy back when price drops this % from the TP sell price. e.g., 20 = -20% from sell. */
  reEntryDipPct: number;
  /** SOL to spend on each re-entry buy. */
  reEntryAmountSol: number;
  /** Max number of re-entries allowed per token. 0 = unlimited. */
  maxReEntries: number;
}

export interface SnipeRequest {
  mintAddress: string;
  side: 'buy' | 'sell';
  amountSol: number;
  slippageBps?: number;
  tag?: string;
  /** Override default exit strategy for this trade. */
  strategy?: Partial<ExitStrategy>;
}

export interface TokenAnalysis {
  hasLiquidity: boolean;
  quote: JupiterQuoteResponse | null;
  estimatedOutput: string | null;
  inputAmount: string | null;
  routeSteps: number;
  warnings: string[];
}

export interface SnipeResult {
  success: boolean;
  tradeId: string | null;
  txSignature: string | null;
  simulated: boolean;
  analysis: TokenAnalysis;
  position: SnipePosition | null;
  error: string | null;
  timestamp: string;
}

export interface TokenPrice {
  priceUsd: number;
  priceChange24hPct: number | null;
  updatedAt: string;
}

/** A tracked position with exit strategy. */
export interface SnipePosition {
  mintAddress: string;
  tokensHeld: string;
  tokenDecimals: number;
  totalSolSpent: number;
  totalSolReceived: number;
  realizedPnlSol: number;
  entryPriceUsd: number | null;
  peakPriceUsd: number | null;
  currentPriceUsd: number | null;
  currentValueUsd: number | null;
  changePct: number | null;
  changeFromPeakPct: number | null;
  priceChange24hPct: number | null;
  exitStrategy: ExitStrategy;
  autoExitReason: string | null;
  /** Whether this position currently holds a moon bag (partial TP already taken). */
  isMoonBag: boolean;
  /** How many times this token has been re-entered after exit. */
  reEntryCount: number;
  buyCount: number;
  sellCount: number;
  firstTradeAt: string;
  lastTradeAt: string;
  priceUpdatedAt: string | null;
  status: 'open' | 'closed';
}

export interface SnipeTrade {
  id: string;
  mintAddress: string;
  side: 'buy' | 'sell';
  amountSol: number;
  tokenAmount: string;
  txSignature: string | null;
  simulated: boolean;
  tag: string | null;
  autoExitReason: string | null;
  timestamp: string;
}

/** A token being watched for dip re-entry after taking profit. */
interface WatchedToken {
  mintAddress: string;
  /** Price at which we sold (TP). We buy back when it dips below this. */
  sellPriceUsd: number;
  /** How far price must dip from sell price to trigger re-entry. */
  reEntryDipPct: number;
  /** SOL to spend on re-entry buy. */
  reEntryAmountSol: number;
  /** Re-entries remaining. 0 = unlimited. Decremented on each re-entry. */
  remainingReEntries: number;
  /** Strategy to apply to the re-entry position. */
  exitStrategy: ExitStrategy;
  /** Token decimals (cached from original position). */
  tokenDecimals: number;
  /** When we started watching for the dip. */
  watchedSince: string;
}

export interface SnipePortfolio {
  openPositions: SnipePosition[];
  closedPositions: SnipePosition[];
  /** Tokens being watched for dip re-entry. */
  watchedForReEntry: { mintAddress: string; sellPriceUsd: number; reEntryBelow: number; remainingReEntries: number }[];
  totalSolSpent: number;
  totalSolReceived: number;
  totalRealizedPnlSol: number;
  totalOpenValueUsd: number | null;
  totalTrades: number;
  walletAddress: string | null;
  priceMonitorActive: boolean;
  priceMonitorIntervalSec: number;
  defaultStrategy: ExitStrategy;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
const DEFAULT_SLIPPAGE_BPS = 300;
const MAX_SLIPPAGE_BPS = 1500;
const DEXSCREENER_API = 'https://api.dexscreener.com/tokens/v1/solana';
const DEFAULT_PRICE_POLL_MS = 10_000;
const MIN_PRICE_POLL_MS = 5_000;

// Default strategy constants.
const DEFAULT_TAKE_PROFIT_PCT = 30;
const DEFAULT_STOP_LOSS_PCT = 15;
const DEFAULT_TRAILING_STOP_PCT = 20;
const DEFAULT_MOON_BAG_PCT = 20;        // Keep 20% on TP.
const DEFAULT_RE_ENTRY_ENABLED = true;
const DEFAULT_RE_ENTRY_DIP_PCT = 25;    // Buy back at -25% from sell.
const DEFAULT_RE_ENTRY_AMOUNT_SOL = 0.01;
const DEFAULT_MAX_RE_ENTRIES = 2;

// ─── Service ─────────────────────────────────────────────────────────────────

export class SnipeService {
  private readonly jupiterClient: JupiterClient;
  private positions: Map<string, SnipePosition> = new Map();
  private prices: Map<string, TokenPrice> = new Map();
  private trades: SnipeTrade[] = [];
  private priceMonitorHandle: ReturnType<typeof setInterval> | null = null;
  private readonly priceIntervalMs: number;
  private defaultStrategy: ExitStrategy;
  private autoExitLocks: Set<string> = new Set();

  /** Tokens being watched for dip re-entry. Key = mint address. */
  private watchedTokens: Map<string, WatchedToken> = new Map();

  /** Path to the persistence file. */
  private readonly persistPath: string;

  /** Debounce timer for disk writes (batch rapid changes). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: AppConfig) {
    this.jupiterClient = new JupiterClient(
      config.trading.jupiterQuoteUrl,
      config.trading.jupiterSwapUrl,
      config.trading.solanaRpcUrl,
      config.trading.solanaPrivateKeyB58,
      config.trading.liveBroadcastEnabled,
    );

    const envInterval = Number(process.env.SNIPE_PRICE_POLL_MS);
    this.priceIntervalMs = Math.max(
      MIN_PRICE_POLL_MS,
      Number.isFinite(envInterval) ? envInterval : DEFAULT_PRICE_POLL_MS,
    );

    // Load default strategy from environment.
    this.defaultStrategy = {
      takeProfitPct: this.envNum('SNIPE_TAKE_PROFIT_PCT', DEFAULT_TAKE_PROFIT_PCT),
      stopLossPct: this.envNum('SNIPE_STOP_LOSS_PCT', DEFAULT_STOP_LOSS_PCT),
      trailingStopPct: this.envNumOrNull('SNIPE_TRAILING_STOP_PCT', DEFAULT_TRAILING_STOP_PCT),
      moonBagPct: this.envNum('SNIPE_MOON_BAG_PCT', DEFAULT_MOON_BAG_PCT),
      reEntryEnabled: this.envBool('SNIPE_RE_ENTRY_ENABLED', DEFAULT_RE_ENTRY_ENABLED),
      reEntryDipPct: this.envNum('SNIPE_RE_ENTRY_DIP_PCT', DEFAULT_RE_ENTRY_DIP_PCT),
      reEntryAmountSol: this.envNum('SNIPE_RE_ENTRY_AMOUNT_SOL', DEFAULT_RE_ENTRY_AMOUNT_SOL),
      maxReEntries: this.envNum('SNIPE_MAX_RE_ENTRIES', DEFAULT_MAX_RE_ENTRIES),
    };

    // Persistence file in the same data directory as the main state.
    this.persistPath = path.resolve(config.paths.dataDir, 'snipe-state.json');
  }

  // ─── Public: Init (load persisted state) ──────────────────────────────

  /**
   * Load persisted snipe state from disk. Call once on startup.
   * Restores positions, trades, watched tokens, and auto-restarts
   * the price monitor if there are open positions.
   */
  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedSnipeState;

      // Restore positions.
      if (data.positions) {
        for (const pos of data.positions) {
          this.positions.set(pos.mintAddress, pos);
        }
      }

      // Restore trades (limit to last 500 to keep memory reasonable).
      if (data.trades) {
        this.trades = data.trades.slice(0, 500);
      }

      // Restore watched tokens.
      if (data.watchedTokens) {
        for (const w of data.watchedTokens) {
          this.watchedTokens.set(w.mintAddress, w);
        }
      }

      // Auto-restart price monitor if we have open positions or watched tokens.
      if (this.getOpenMintAddresses().length > 0 || this.watchedTokens.size > 0) {
        this.startPriceMonitor();
      }
    } catch {
      // No persisted state — fresh start.
    }
  }

  // ─── Public: Status ──────────────────────────────────────────────────

  isReady(): boolean { return this.jupiterClient.isReadyForLive(); }
  walletAddress(): string | undefined { return this.jupiterClient.publicKey(); }
  getDefaultStrategy(): ExitStrategy { return { ...this.defaultStrategy }; }

  // ─── Public: Strategy Override ────────────────────────────────────────

  updatePositionStrategy(mintAddress: string, overrides: Partial<ExitStrategy>): SnipePosition | null {
    const position = this.positions.get(mintAddress);
    if (!position || position.status !== 'open') return null;
    this.applyStrategyOverrides(position.exitStrategy, overrides);
    eventBus.emit('snipe.strategy_updated', { mintAddress, overrides });
    this.schedulePersist();
    return this.enrichPosition(position);
  }

  updateDefaultStrategy(overrides: Partial<ExitStrategy>): ExitStrategy {
    this.applyStrategyOverrides(this.defaultStrategy, overrides);
    return { ...this.defaultStrategy };
  }

  // ─── Public: Price Monitor ───────────────────────────────────────────

  startPriceMonitor(): void {
    if (this.priceMonitorHandle) return;
    this.pollPrices();
    this.priceMonitorHandle = setInterval(() => { this.pollPrices(); }, this.priceIntervalMs);
  }

  stopPriceMonitor(): void {
    if (this.priceMonitorHandle) { clearInterval(this.priceMonitorHandle); this.priceMonitorHandle = null; }
  }

  isPriceMonitorActive(): boolean { return this.priceMonitorHandle !== null; }

  // ─── Public: Portfolio & Positions ───────────────────────────────────

  getPortfolio(): SnipePortfolio {
    const all = Array.from(this.positions.values()).map((p) => this.enrichPosition(p));
    const open = all.filter((p) => p.status === 'open');
    const closed = all.filter((p) => p.status === 'closed');

    let totalOpenValueUsd: number | null = 0;
    for (const p of open) {
      if (p.currentValueUsd === null) { totalOpenValueUsd = null; break; }
      totalOpenValueUsd += p.currentValueUsd;
    }

    // Build watched-for-reentry summary.
    const watchedForReEntry = Array.from(this.watchedTokens.values()).map((w) => ({
      mintAddress: w.mintAddress,
      sellPriceUsd: w.sellPriceUsd,
      reEntryBelow: Number((w.sellPriceUsd * (1 - w.reEntryDipPct / 100)).toFixed(10)),
      remainingReEntries: w.remainingReEntries,
    }));

    return {
      openPositions: open,
      closedPositions: closed,
      watchedForReEntry,
      totalSolSpent: all.reduce((sum, p) => sum + p.totalSolSpent, 0),
      totalSolReceived: all.reduce((sum, p) => sum + p.totalSolReceived, 0),
      totalRealizedPnlSol: all.reduce((sum, p) => sum + p.realizedPnlSol, 0),
      totalOpenValueUsd,
      totalTrades: this.trades.length,
      walletAddress: this.walletAddress() ?? null,
      priceMonitorActive: this.isPriceMonitorActive(),
      priceMonitorIntervalSec: this.priceIntervalMs / 1000,
      defaultStrategy: { ...this.defaultStrategy },
    };
  }

  getPosition(mintAddress: string): SnipePosition | null {
    const raw = this.positions.get(mintAddress);
    return raw ? this.enrichPosition(raw) : null;
  }

  getTrades(mintAddress?: string, limit = 50): SnipeTrade[] {
    let result = this.trades;
    if (mintAddress) result = result.filter((t) => t.mintAddress === mintAddress);
    return result.slice(0, limit);
  }

  // ─── Public: Analyze ─────────────────────────────────────────────────

  async analyzeToken(mintAddress: string, amountSol: number, side: 'buy' | 'sell' = 'buy', slippageBps?: number): Promise<TokenAnalysis> {
    const warnings: string[] = [];
    const slippage = Math.min(slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintAddress)) {
      return { hasLiquidity: false, quote: null, estimatedOutput: null, inputAmount: null, routeSteps: 0, warnings: ['Invalid mint address format.'] };
    }
    if (mintAddress === SOL_MINT) {
      return { hasLiquidity: false, quote: null, estimatedOutput: null, inputAmount: null, routeSteps: 0, warnings: ['Cannot snipe SOL itself.'] };
    }

    const lamports = Math.floor(amountSol * 10 ** SOL_DECIMALS);
    if (lamports <= 0) {
      return { hasLiquidity: false, quote: null, estimatedOutput: null, inputAmount: null, routeSteps: 0, warnings: ['Amount too small.'] };
    }

    try {
      const inputMint = side === 'buy' ? SOL_MINT : mintAddress;
      const outputMint = side === 'buy' ? mintAddress : SOL_MINT;
      const quote = await this.jupiterClient.quote({ inputMint, outputMint, amount: lamports, slippageBps: slippage });
      const routeSteps = Array.isArray(quote.routePlan) ? quote.routePlan.length : 0;
      if (routeSteps > 3) warnings.push(`Complex route: ${routeSteps} steps. Higher risk of failure.`);
      return { hasLiquidity: true, quote, estimatedOutput: quote.outAmount ?? null, inputAmount: quote.inAmount ?? null, routeSteps, warnings };
    } catch (error) {
      return { hasLiquidity: false, quote: null, estimatedOutput: null, inputAmount: null, routeSteps: 0, warnings: [`No liquidity or invalid token: ${String(error)}`] };
    }
  }

  // ─── Public: Snipe (Trade + Track) ───────────────────────────────────

  async snipe(request: SnipeRequest): Promise<SnipeResult> {
    const { mintAddress, side, amountSol, slippageBps, tag, strategy } = request;
    const timestamp = new Date().toISOString();

    // If we're buying a token we were watching for re-entry, remove it from watch list.
    if (side === 'buy') this.watchedTokens.delete(mintAddress);

    const analysis = await this.analyzeToken(mintAddress, amountSol, side, slippageBps);

    if (!analysis.hasLiquidity || !analysis.quote) {
      return {
        success: false, tradeId: null, txSignature: null, simulated: false,
        analysis, position: null,
        error: analysis.warnings.join('; ') || 'No liquidity found.',
        timestamp,
      };
    }

    try {
      const swap = await this.jupiterClient.swapFromQuote(analysis.quote);
      const tokenAmount = side === 'buy' ? (analysis.estimatedOutput ?? '0') : (analysis.inputAmount ?? '0');
      const decimals = this.extractDecimals(analysis.quote, mintAddress);

      // Calculate entry price from the Jupiter quote.
      let entryPriceUsd: number | null = null;
      if (side === 'buy') {
        const swapUsdValue = Number((analysis.quote as Record<string, unknown>)['swapUsdValue']);
        const tokenCount = Number(BigInt(tokenAmount)) / (10 ** decimals);
        if (Number.isFinite(swapUsdValue) && swapUsdValue > 0 && tokenCount > 0) {
          entryPriceUsd = swapUsdValue / tokenCount;
        }
      }

      // Merge per-trade overrides with defaults.
      const exitStrategy = this.buildStrategy(strategy);

      const tradeId = uuid();
      const trade: SnipeTrade = {
        id: tradeId, mintAddress, side, amountSol, tokenAmount,
        txSignature: swap.txSignature ?? null,
        simulated: swap.simulated,
        tag: tag ?? null, autoExitReason: null, timestamp,
      };

      this.trades.unshift(trade);
      const position = this.updatePosition(mintAddress, side, amountSol, tokenAmount, decimals, entryPriceUsd, exitStrategy, timestamp);

      // Emit event and persist.
      this.emitTradeEvent(trade, position);
      this.schedulePersist();

      // Auto-start price monitor when we have open positions or watched tokens.
      if ((position.status === 'open' || this.watchedTokens.size > 0) && !this.isPriceMonitorActive()) {
        this.startPriceMonitor();
      }
      if (this.getOpenMintAddresses().length === 0 && this.watchedTokens.size === 0) {
        this.stopPriceMonitor();
      }

      return {
        success: true, tradeId,
        txSignature: swap.txSignature ?? null,
        simulated: swap.simulated,
        analysis, position: this.enrichPosition(position),
        error: null, timestamp,
      };
    } catch (error) {
      const existingPos = this.positions.get(mintAddress);
      return {
        success: false, tradeId: null, txSignature: null, simulated: false,
        analysis, position: existingPos ? this.enrichPosition(existingPos) : null,
        error: `Swap failed: ${String(error)}`,
        timestamp,
      };
    }
  }

  // ─── Private: Price Polling + Auto Exit + Re-Entry ───────────────────

  private async pollPrices(): Promise<void> {
    // Collect all mints we need prices for: open positions + watched re-entries.
    const openMints = this.getOpenMintAddresses();
    const watchedMints = Array.from(this.watchedTokens.keys());
    const allMints = [...new Set([...openMints, ...watchedMints])];

    if (allMints.length === 0) { this.stopPriceMonitor(); return; }

    try {
      const freshPrices = await this.fetchTokenPrices(allMints);
      const now = new Date().toISOString();

      for (const [mint, data] of Object.entries(freshPrices)) {
        this.prices.set(mint, { priceUsd: data.priceUsd, priceChange24hPct: data.priceChange24hPct, updatedAt: now });

        const position = this.positions.get(mint);
        if (position && position.status === 'open') {
          if (position.entryPriceUsd === null) position.entryPriceUsd = data.priceUsd;
          if (position.peakPriceUsd === null || data.priceUsd > position.peakPriceUsd) {
            position.peakPriceUsd = data.priceUsd;
          }
        }
      }

      // Check exit conditions for open positions.
      await this.checkAutoExits();

      // Check re-entry conditions for watched tokens.
      await this.checkReEntries();
    } catch {
      // Silently ignore — prices will be stale until next poll.
    }
  }

  /**
   * Check all open positions against their exit strategies.
   * Handles TP (with moon bag), SL, and trailing stop.
   */
  private async checkAutoExits(): Promise<void> {
    for (const [mint, position] of this.positions) {
      if (position.status !== 'open') continue;
      if (position.entryPriceUsd === null) continue;
      if (this.autoExitLocks.has(mint)) continue;

      const price = this.prices.get(mint);
      if (!price) continue;

      const currentPrice = price.priceUsd;
      const entryPrice = position.entryPriceUsd;
      const peakPrice = position.peakPriceUsd ?? currentPrice;
      const strategy = position.exitStrategy;

      const changeFromEntry = ((currentPrice - entryPrice) / entryPrice) * 100;
      const changeFromPeak = ((currentPrice - peakPrice) / peakPrice) * 100;

      let exitReason: string | null = null;
      let isTakeProfit = false;

      // Take profit: price above entry by TP%.
      if (changeFromEntry >= strategy.takeProfitPct) {
        exitReason = `take_profit:+${changeFromEntry.toFixed(1)}%_(target:+${strategy.takeProfitPct}%)`;
        isTakeProfit = true;
      }

      // Stop loss: price below entry by SL%. (Overrides TP if both somehow trigger.)
      if (changeFromEntry <= -strategy.stopLossPct) {
        exitReason = `stop_loss:${changeFromEntry.toFixed(1)}%_(limit:-${strategy.stopLossPct}%)`;
        isTakeProfit = false;
      }

      // Trailing stop: price dropped from peak by trailing%.
      if (strategy.trailingStopPct !== null && changeFromPeak <= -strategy.trailingStopPct) {
        exitReason = `trailing_stop:${changeFromPeak.toFixed(1)}%_from_peak_(limit:-${strategy.trailingStopPct}%)`;
        isTakeProfit = false;
      }

      if (exitReason) {
        this.executeAutoExit(mint, position, exitReason, isTakeProfit);
      }
    }
  }

  /**
   * Check watched tokens for dip re-entry.
   * If price drops enough from the TP sell price, auto-buy back in.
   */
  private async checkReEntries(): Promise<void> {
    for (const [mint, watched] of this.watchedTokens) {
      if (this.autoExitLocks.has(mint)) continue;

      const price = this.prices.get(mint);
      if (!price) continue;

      const currentPrice = price.priceUsd;
      const changeFromSell = ((currentPrice - watched.sellPriceUsd) / watched.sellPriceUsd) * 100;

      // Trigger re-entry when price drops enough from the sell price.
      if (changeFromSell <= -watched.reEntryDipPct) {
        this.executeReEntry(mint, watched, currentPrice);
      }
    }
  }

  /**
   * Auto-sell a position. Handles both full exit and partial exit (moon bag).
   *
   * On take-profit with moonBagPct > 0:
   *   - Sells (100 - moonBagPct)% of tokens
   *   - Keeps the rest as a moon bag (position stays open)
   *   - Moon bag gets trailing stop only (no TP ceiling)
   *   - Optionally starts watching for dip re-entry
   *
   * On stop-loss or trailing stop: always sells 100%.
   */
  private async executeAutoExit(mintAddress: string, position: SnipePosition, reason: string, isTakeProfit: boolean): Promise<void> {
    if (this.autoExitLocks.has(mintAddress)) return;
    this.autoExitLocks.add(mintAddress);

    try {
      const strategy = position.exitStrategy;
      const totalTokens = BigInt(position.tokensHeld);

      // Determine how many tokens to sell.
      let sellTokens: bigint;
      let keepMoonBag = false;

      if (isTakeProfit && strategy.moonBagPct > 0 && !position.isMoonBag) {
        // Partial sell: keep moonBagPct% as a moon bag.
        const sellPct = 100 - strategy.moonBagPct;
        sellTokens = (totalTokens * BigInt(Math.round(sellPct))) / BigInt(100);
        keepMoonBag = true;
      } else {
        // Full sell: SL, trailing, or moon bag getting stopped out.
        sellTokens = totalTokens;
      }

      if (sellTokens <= BigInt(0)) { return; }

      // Get Jupiter quote for selling tokens → SOL.
      const quote = await this.jupiterClient.quote({
        inputMint: mintAddress,
        outputMint: SOL_MINT,
        amount: Number(sellTokens),
        slippageBps: 500, // Higher slippage for urgency.
      });

      const swap = await this.jupiterClient.swapFromQuote(quote);
      const timestamp = new Date().toISOString();

      // Estimate SOL received from the sell.
      const tokenCount = Number(sellTokens) / (10 ** position.tokenDecimals);
      const currentPrice = this.prices.get(mintAddress)?.priceUsd ?? 0;
      const solPrice = this.prices.get(SOL_MINT)?.priceUsd ?? 200;
      const estimatedSolValue = Math.max(0.001, (tokenCount * currentPrice) / solPrice);

      const tagLabel = keepMoonBag
        ? `auto-tp-partial(${100 - strategy.moonBagPct}%_sold,${strategy.moonBagPct}%_moon_bag)`
        : `auto-exit`;

      const trade: SnipeTrade = {
        id: uuid(), mintAddress, side: 'sell',
        amountSol: estimatedSolValue,
        tokenAmount: sellTokens.toString(),
        txSignature: swap.txSignature ?? null,
        simulated: swap.simulated,
        tag: tagLabel, autoExitReason: reason, timestamp,
      };

      this.trades.unshift(trade);

      // Update position balances.
      const remainingTokens = totalTokens - sellTokens;
      position.tokensHeld = remainingTokens.toString();
      position.totalSolReceived += estimatedSolValue;
      position.sellCount += 1;
      position.realizedPnlSol = position.totalSolReceived - position.totalSolSpent;
      position.lastTradeAt = timestamp;

      if (keepMoonBag && remainingTokens > BigInt(0)) {
        // Moon bag: position stays open with special rules.
        position.isMoonBag = true;
        position.status = 'open';
        // Reset peak price so trailing stop tracks fresh from here.
        position.peakPriceUsd = currentPrice;
        // Disable TP on moon bag — let it ride. Keep SL and trailing.
        position.exitStrategy.takeProfitPct = 999999;

        // Start watching for dip re-entry if enabled.
        if (strategy.reEntryEnabled) {
          this.addToWatchList(mintAddress, currentPrice, position);
        }
      } else {
        // Full close.
        position.status = 'closed';
        position.autoExitReason = reason;

        // Watch for dip re-entry if this was a TP (not SL).
        if (isTakeProfit && strategy.reEntryEnabled) {
          this.addToWatchList(mintAddress, currentPrice, position);
        }
      }

      // Emit event and persist.
      this.emitTradeEvent(trade, position);
      eventBus.emit('snipe.auto_exit', { mintAddress, reason, isTakeProfit, keepMoonBag });
      this.schedulePersist();

    } catch {
      // Auto-exit failed. Will retry on next price poll.
    } finally {
      this.autoExitLocks.delete(mintAddress);
    }
  }

  /**
   * Auto re-entry: buy back into a token after a dip from the TP sell price.
   */
  private async executeReEntry(mintAddress: string, watched: WatchedToken, currentPrice: number): Promise<void> {
    if (this.autoExitLocks.has(mintAddress)) return;
    this.autoExitLocks.add(mintAddress);

    try {
      const lamports = Math.floor(watched.reEntryAmountSol * 10 ** SOL_DECIMALS);

      const quote = await this.jupiterClient.quote({
        inputMint: SOL_MINT,
        outputMint: mintAddress,
        amount: lamports,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });

      const swap = await this.jupiterClient.swapFromQuote(quote);
      const timestamp = new Date().toISOString();
      const tokenAmount = quote.outAmount ?? '0';

      const dipPct = (((currentPrice - watched.sellPriceUsd) / watched.sellPriceUsd) * 100).toFixed(1);

      const trade: SnipeTrade = {
        id: uuid(), mintAddress, side: 'buy',
        amountSol: watched.reEntryAmountSol,
        tokenAmount,
        txSignature: swap.txSignature ?? null,
        simulated: swap.simulated,
        tag: `auto-reentry(dip:${dipPct}%_from_tp_sell)`,
        autoExitReason: null, timestamp,
      };

      this.trades.unshift(trade);

      // Build fresh strategy for the re-entry (use the stored strategy, not moon-bag-modified one).
      const reEntryStrategy = { ...watched.exitStrategy };
      // Restore a normal TP (not the 999999 moon bag value).
      if (reEntryStrategy.takeProfitPct >= 999999) {
        reEntryStrategy.takeProfitPct = this.defaultStrategy.takeProfitPct;
      }

      // Update or re-open the position.
      const position = this.updatePosition(
        mintAddress, 'buy', watched.reEntryAmountSol, tokenAmount,
        watched.tokenDecimals, currentPrice, reEntryStrategy, timestamp,
      );

      position.reEntryCount += 1;
      // Reset peak for fresh trailing stop tracking.
      position.peakPriceUsd = currentPrice;
      position.isMoonBag = false;

      // Remove from watch list (or decrement re-entries).
      if (watched.remainingReEntries !== 0) {
        watched.remainingReEntries -= 1;
        if (watched.remainingReEntries <= 0) {
          this.watchedTokens.delete(mintAddress);
        }
      }
      // If remainingReEntries was 0 (unlimited), keep watching — it'll re-add after next TP.
      // For now, remove and let the next TP re-add it.
      this.watchedTokens.delete(mintAddress);

      // Emit event and persist.
      this.emitTradeEvent(trade, position);
      eventBus.emit('snipe.re_entry', { mintAddress, dipPct, reEntryCount: position.reEntryCount });
      this.schedulePersist();

    } catch {
      // Re-entry failed. Will retry on next price poll.
    } finally {
      this.autoExitLocks.delete(mintAddress);
    }
  }

  // ─── Private: Watch List for Re-Entry ─────────────────────────────────

  private addToWatchList(mintAddress: string, sellPriceUsd: number, position: SnipePosition): void {
    const strategy = position.exitStrategy;

    // Check re-entry limit.
    if (strategy.maxReEntries > 0 && position.reEntryCount >= strategy.maxReEntries) {
      return; // Max re-entries reached for this token.
    }

    const remaining = strategy.maxReEntries > 0
      ? strategy.maxReEntries - position.reEntryCount
      : 0; // 0 = unlimited.

    this.watchedTokens.set(mintAddress, {
      mintAddress,
      sellPriceUsd,
      reEntryDipPct: strategy.reEntryDipPct,
      reEntryAmountSol: strategy.reEntryAmountSol,
      remainingReEntries: remaining,
      exitStrategy: { ...strategy },
      tokenDecimals: position.tokenDecimals,
      watchedSince: new Date().toISOString(),
    });
  }

  // ─── Private: DexScreener Price Fetch ────────────────────────────────

  private async fetchTokenPrices(mints: string[]): Promise<Record<string, { priceUsd: number; priceChange24hPct: number | null }>> {
    const result: Record<string, { priceUsd: number; priceChange24hPct: number | null }> = {};
    const batches = this.chunk(mints, 30);

    for (const batch of batches) {
      const url = `${DEXSCREENER_API}/${batch.join(',')}`;
      const response = await fetch(url);
      if (!response.ok) continue;

      const pairs = (await response.json()) as Array<{
        baseToken?: { address?: string };
        priceUsd?: string;
        priceChange?: { h24?: number };
      }>;

      if (!Array.isArray(pairs)) continue;

      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        const price = Number(pair.priceUsd);
        if (mint && Number.isFinite(price) && price > 0 && !result[mint]) {
          result[mint] = { priceUsd: price, priceChange24hPct: pair.priceChange?.h24 ?? null };
        }
      }
    }

    return result;
  }

  // ─── Private: Position Tracking ──────────────────────────────────────

  private updatePosition(
    mintAddress: string, side: 'buy' | 'sell', solAmount: number,
    tokenAmount: string, decimals: number, entryPriceUsd: number | null,
    exitStrategy: ExitStrategy, timestamp: string,
  ): SnipePosition {
    let position = this.positions.get(mintAddress);

    if (!position) {
      position = {
        mintAddress, tokensHeld: '0', tokenDecimals: decimals,
        totalSolSpent: 0, totalSolReceived: 0, realizedPnlSol: 0,
        entryPriceUsd: null, peakPriceUsd: null,
        currentPriceUsd: null, currentValueUsd: null,
        changePct: null, changeFromPeakPct: null, priceChange24hPct: null,
        exitStrategy: { ...exitStrategy },
        autoExitReason: null, isMoonBag: false, reEntryCount: 0,
        buyCount: 0, sellCount: 0,
        firstTradeAt: timestamp, lastTradeAt: timestamp,
        priceUpdatedAt: null, status: 'open',
      };
      this.positions.set(mintAddress, position);
    }

    const currentTokens = BigInt(position.tokensHeld);
    const tradeTokens = BigInt(tokenAmount);

    if (side === 'buy') {
      position.tokensHeld = (currentTokens + tradeTokens).toString();
      position.totalSolSpent += solAmount;
      position.buyCount += 1;
      if (decimals > 0) position.tokenDecimals = decimals;
      if (entryPriceUsd !== null) position.entryPriceUsd = entryPriceUsd;
      position.exitStrategy = { ...exitStrategy };
      position.autoExitReason = null; // Clear on re-buy.
      position.status = 'open';
    } else {
      const remaining = currentTokens > tradeTokens ? currentTokens - tradeTokens : BigInt(0);
      position.tokensHeld = remaining.toString();
      position.totalSolReceived += solAmount;
      position.sellCount += 1;
      position.realizedPnlSol = position.totalSolReceived - position.totalSolSpent;
    }

    position.lastTradeAt = timestamp;
    if (side !== 'buy') {
      position.status = BigInt(position.tokensHeld) > BigInt(0) ? 'open' : 'closed';
    }
    return position;
  }

  private enrichPosition(position: SnipePosition): SnipePosition {
    const enriched = { ...position, exitStrategy: { ...position.exitStrategy } };
    const price = this.prices.get(position.mintAddress);

    if (price) {
      enriched.currentPriceUsd = price.priceUsd;
      enriched.priceChange24hPct = price.priceChange24hPct;
      enriched.priceUpdatedAt = price.updatedAt;

      const tokenCount = Number(BigInt(position.tokensHeld)) / (10 ** position.tokenDecimals);
      enriched.currentValueUsd = Number((tokenCount * price.priceUsd).toFixed(6));

      if (position.entryPriceUsd !== null && position.entryPriceUsd > 0) {
        enriched.changePct = Number((((price.priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100).toFixed(2));
      }
      if (position.peakPriceUsd !== null && position.peakPriceUsd > 0) {
        enriched.changeFromPeakPct = Number((((price.priceUsd - position.peakPriceUsd) / position.peakPriceUsd) * 100).toFixed(2));
      }
    }

    return enriched;
  }

  // ─── Private: Helpers ────────────────────────────────────────────────

  private buildStrategy(overrides?: Partial<ExitStrategy>): ExitStrategy {
    return {
      takeProfitPct: overrides?.takeProfitPct ?? this.defaultStrategy.takeProfitPct,
      stopLossPct: overrides?.stopLossPct ?? this.defaultStrategy.stopLossPct,
      trailingStopPct: overrides?.trailingStopPct !== undefined ? overrides.trailingStopPct : this.defaultStrategy.trailingStopPct,
      moonBagPct: overrides?.moonBagPct ?? this.defaultStrategy.moonBagPct,
      reEntryEnabled: overrides?.reEntryEnabled ?? this.defaultStrategy.reEntryEnabled,
      reEntryDipPct: overrides?.reEntryDipPct ?? this.defaultStrategy.reEntryDipPct,
      reEntryAmountSol: overrides?.reEntryAmountSol ?? this.defaultStrategy.reEntryAmountSol,
      maxReEntries: overrides?.maxReEntries ?? this.defaultStrategy.maxReEntries,
    };
  }

  private applyStrategyOverrides(target: ExitStrategy, overrides: Partial<ExitStrategy>): void {
    if (overrides.takeProfitPct !== undefined) target.takeProfitPct = overrides.takeProfitPct;
    if (overrides.stopLossPct !== undefined) target.stopLossPct = overrides.stopLossPct;
    if (overrides.trailingStopPct !== undefined) target.trailingStopPct = overrides.trailingStopPct;
    if (overrides.moonBagPct !== undefined) target.moonBagPct = overrides.moonBagPct;
    if (overrides.reEntryEnabled !== undefined) target.reEntryEnabled = overrides.reEntryEnabled;
    if (overrides.reEntryDipPct !== undefined) target.reEntryDipPct = overrides.reEntryDipPct;
    if (overrides.reEntryAmountSol !== undefined) target.reEntryAmountSol = overrides.reEntryAmountSol;
    if (overrides.maxReEntries !== undefined) target.maxReEntries = overrides.maxReEntries;
  }

  private getOpenMintAddresses(): string[] {
    return Array.from(this.positions.entries())
      .filter(([, pos]) => pos.status === 'open')
      .map(([mint]) => mint);
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  private extractDecimals(quote: JupiterQuoteResponse, mintAddress: string): number {
    const known: Record<string, number> = {
      'So11111111111111111111111111111111111111112': 9,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,
    };
    if (known[mintAddress]) return known[mintAddress];
    const d = (quote as Record<string, unknown>)['outputDecimals'] ?? (quote as Record<string, unknown>)['decimals'];
    if (typeof d === 'number' && d > 0) return d;
    return 6;
  }

  private envNum(key: string, fallback: number): number {
    const v = Number(process.env[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  private envNumOrNull(key: string, fallback: number | null): number | null {
    const raw = process.env[key];
    if (raw === 'false' || raw === 'off' || raw === '0') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  }

  private envBool(key: string, fallback: boolean): boolean {
    const raw = process.env[key]?.toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return fallback;
  }

  // ─── Private: Persistence ────────────────────────────────────────────

  /**
   * Schedule a debounced save to disk (100ms debounce).
   * Prevents hammering the filesystem during rapid price polls.
   */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistToDisk(); }, 100);
  }

  /** Write snipe state to disk as JSON. */
  private async persistToDisk(): Promise<void> {
    try {
      const data: PersistedSnipeState = {
        positions: Array.from(this.positions.values()),
        trades: this.trades.slice(0, 500), // Keep last 500 trades.
        watchedTokens: Array.from(this.watchedTokens.values()),
        savedAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.writeFile(this.persistPath, JSON.stringify(data, null, 2));
    } catch {
      // Silently ignore — persistence is best-effort.
    }
  }

  // ─── Private: Event Emission ──────────────────────────────────────────

  /** Emit a snipe trade event for other services to consume. */
  private emitTradeEvent(trade: SnipeTrade, position: SnipePosition): void {
    eventBus.emit('snipe.trade', {
      tradeId: trade.id,
      mintAddress: trade.mintAddress,
      side: trade.side,
      amountSol: trade.amountSol,
      tokenAmount: trade.tokenAmount,
      txSignature: trade.txSignature,
      simulated: trade.simulated,
      tag: trade.tag,
      autoExitReason: trade.autoExitReason,
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd: position.currentPriceUsd,
      realizedPnlSol: position.realizedPnlSol,
      status: position.status,
      timestamp: trade.timestamp,
    });
  }
}

// ─── Persisted state shape ──────────────────────────────────────────────────

interface PersistedSnipeState {
  positions: SnipePosition[];
  trades: SnipeTrade[];
  watchedTokens: WatchedToken[];
  savedAt: string;
}
