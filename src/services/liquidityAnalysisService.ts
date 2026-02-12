/**
 * Liquidity Analysis Service for DeFi Pools.
 *
 * Features:
 * - Pool depth analysis (simulate slippage at different trade sizes)
 * - Liquidity heatmap (price levels with most/least liquidity)
 * - Impermanent loss calculator
 * - Pool fee APR estimation
 * - Best execution routing (which pool/path for a given size)
 * - Historical liquidity tracking
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PoolInfo {
  poolId: string;
  pair: string;
  dex: string;
  reserveBase: number;
  reserveQuote: number;
  feeRate: number;          // e.g. 0.003 for 0.3%
  volume24hUsd: number;
  tvlUsd: number;
  lastUpdated: string;
}

export interface SlippageBucket {
  tradeSizeUsd: number;
  slippagePct: number;
  effectivePrice: number;
  priceImpactPct: number;
}

export interface DepthAnalysis {
  pair: string;
  currentPrice: number;
  pools: Array<{
    poolId: string;
    dex: string;
    tvlUsd: number;
    slippageBuckets: SlippageBucket[];
  }>;
  aggregatedDepth: SlippageBucket[];
  timestamp: string;
}

export interface HeatmapLevel {
  priceLevel: number;
  liquidityUsd: number;
  pctOfTotal: number;
  side: 'bid' | 'ask';
}

export interface LiquidityHeatmap {
  pair: string;
  currentPrice: number;
  levels: HeatmapLevel[];
  totalLiquidityUsd: number;
  concentrationScore: number;  // 0-100, higher = more concentrated around current price
  timestamp: string;
}

export interface ImpermanentLossInput {
  initialPriceRatio: number;
  currentPriceRatio: number;
  depositValueUsd: number;
  feeAprPct?: number;
}

export interface ImpermanentLossResult {
  impermanentLossPct: number;
  impermanentLossUsd: number;
  holdValueUsd: number;
  lpValueUsd: number;
  feeEarningsUsd: number;
  netPnlUsd: number;
  breakEvenDays: number | null;
  priceRatioChange: number;
}

export interface PoolAprEstimate {
  pair: string;
  pools: Array<{
    poolId: string;
    dex: string;
    feeAprPct: number;
    volume24hUsd: number;
    tvlUsd: number;
    dailyFeeUsd: number;
    weeklyFeeUsd: number;
    monthlyFeeUsd: number;
  }>;
  bestPool: string;
  bestAprPct: number;
  timestamp: string;
}

export interface RouteStep {
  poolId: string;
  dex: string;
  pair: string;
  inputToken: string;
  outputToken: string;
  inputAmount: number;
  outputAmount: number;
  slippagePct: number;
  feeUsd: number;
}

export interface ExecutionRoute {
  steps: RouteStep[];
  inputToken: string;
  outputToken: string;
  inputAmountUsd: number;
  outputAmountUsd: number;
  totalSlippagePct: number;
  totalFeeUsd: number;
  effectivePrice: number;
  savings: number;           // vs worst route
}

export interface RouteResult {
  bestRoute: ExecutionRoute;
  alternativeRoutes: ExecutionRoute[];
  timestamp: string;
}

export interface LiquiditySnapshot {
  pair: string;
  totalTvlUsd: number;
  poolCount: number;
  avgSlippageBps: number;
  concentrationScore: number;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TRADE_SIZES = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000];
const HEATMAP_LEVELS = 20;
const MAX_HISTORY_PER_PAIR = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Constant-product AMM slippage calculation.
 * Given reserves and trade size, compute output and slippage.
 */
function computeAmmSlippage(
  reserveIn: number,
  reserveOut: number,
  amountIn: number,
  feeRate: number,
): { amountOut: number; slippagePct: number; effectivePrice: number; priceImpactPct: number } {
  const amountInAfterFee = amountIn * (1 - feeRate);
  const newReserveIn = reserveIn + amountInAfterFee;
  const newReserveOut = (reserveIn * reserveOut) / newReserveIn;
  const amountOut = reserveOut - newReserveOut;

  const spotPrice = reserveOut / reserveIn;
  const effectivePrice = amountOut / amountIn;
  const slippagePct = spotPrice > 0
    ? Math.abs((effectivePrice - spotPrice) / spotPrice) * 100
    : 0;
  const priceImpactPct = reserveIn > 0
    ? (amountInAfterFee / reserveIn) * 100
    : 0;

  return { amountOut, slippagePct, effectivePrice, priceImpactPct };
}

/**
 * Compute impermanent loss percentage for a given price ratio change.
 * IL = 2 * sqrt(r) / (1 + r) - 1
 * where r = newPrice / oldPrice
 */
function computeImpermanentLoss(priceRatioChange: number): number {
  if (priceRatioChange <= 0) return 0;
  const sqrtR = Math.sqrt(priceRatioChange);
  return (2 * sqrtR) / (1 + priceRatioChange) - 1;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class LiquidityAnalysisService {
  /** pair → registered pools */
  private pools: Map<string, PoolInfo[]> = new Map();
  /** pair → liquidity snapshots history */
  private history: Map<string, LiquiditySnapshot[]> = new Map();

  constructor(private readonly store: StateStore) {
    this.seedDefaultPools();
  }

  // ─── Pool Registration ──────────────────────────────────────────────

  /**
   * Register or update a pool for analysis.
   */
  registerPool(pool: PoolInfo): PoolInfo {
    const pair = pool.pair.toUpperCase();
    const normalizedPool = { ...pool, pair, lastUpdated: isoNow() };

    if (!this.pools.has(pair)) {
      this.pools.set(pair, []);
    }

    const pairPools = this.pools.get(pair)!;
    const existing = pairPools.findIndex((p) => p.poolId === pool.poolId);
    if (existing >= 0) {
      pairPools[existing] = normalizedPool;
    } else {
      pairPools.push(normalizedPool);
    }

    return structuredClone(normalizedPool);
  }

  /**
   * Get all registered pools for a pair.
   */
  getPools(pair: string): PoolInfo[] {
    const upper = pair.toUpperCase();
    return structuredClone(this.pools.get(upper) ?? []);
  }

  // ─── Pool Depth Analysis ────────────────────────────────────────────

  /**
   * Analyze pool depth by simulating slippage at different trade sizes.
   */
  analyzeDepth(pair: string, tradeSizes?: number[]): DepthAnalysis {
    const upper = pair.toUpperCase();
    const pools = this.pools.get(upper) ?? [];
    const sizes = tradeSizes ?? DEFAULT_TRADE_SIZES;
    const currentPrice = this.getCurrentPrice(upper);

    const poolDepths = pools.map((pool) => {
      const slippageBuckets = sizes.map((size) => {
        const amountIn = size / currentPrice;
        const result = computeAmmSlippage(
          pool.reserveBase,
          pool.reserveQuote,
          amountIn,
          pool.feeRate,
        );
        return {
          tradeSizeUsd: size,
          slippagePct: Math.round(result.slippagePct * 10000) / 10000,
          effectivePrice: Math.round(result.effectivePrice * 100000) / 100000,
          priceImpactPct: Math.round(result.priceImpactPct * 10000) / 10000,
        };
      });

      return {
        poolId: pool.poolId,
        dex: pool.dex,
        tvlUsd: pool.tvlUsd,
        slippageBuckets,
      };
    });

    // Aggregate depth across pools (weighted by TVL)
    const totalTvl = pools.reduce((s, p) => s + p.tvlUsd, 0);
    const aggregatedDepth = sizes.map((size) => {
      if (totalTvl === 0) {
        return { tradeSizeUsd: size, slippagePct: 0, effectivePrice: currentPrice, priceImpactPct: 0 };
      }

      let weightedSlippage = 0;
      let weightedPrice = 0;
      let weightedImpact = 0;

      for (const pd of poolDepths) {
        const pool = pools.find((p) => p.poolId === pd.poolId)!;
        const weight = pool.tvlUsd / totalTvl;
        const bucket = pd.slippageBuckets.find((b) => b.tradeSizeUsd === size)!;
        weightedSlippage += bucket.slippagePct * weight;
        weightedPrice += bucket.effectivePrice * weight;
        weightedImpact += bucket.priceImpactPct * weight;
      }

      return {
        tradeSizeUsd: size,
        slippagePct: Math.round(weightedSlippage * 10000) / 10000,
        effectivePrice: Math.round(weightedPrice * 100000) / 100000,
        priceImpactPct: Math.round(weightedImpact * 10000) / 10000,
      };
    });

    // Record a historical snapshot
    this.recordSnapshot(upper, pools);

    return {
      pair: upper,
      currentPrice,
      pools: poolDepths,
      aggregatedDepth,
      timestamp: isoNow(),
    };
  }

  // ─── Liquidity Heatmap ──────────────────────────────────────────────

  /**
   * Generate a liquidity heatmap showing price levels with most/least liquidity.
   */
  getHeatmap(pair: string, levels?: number): LiquidityHeatmap {
    const upper = pair.toUpperCase();
    const pools = this.pools.get(upper) ?? [];
    const currentPrice = this.getCurrentPrice(upper);
    const numLevels = levels ?? HEATMAP_LEVELS;

    // Generate price levels around current price (±50%)
    const priceLevels: HeatmapLevel[] = [];
    const halfLevels = Math.floor(numLevels / 2);
    const stepPct = 0.05; // 5% per level

    let totalLiquidity = 0;

    for (let i = -halfLevels; i <= halfLevels; i++) {
      const priceLevel = currentPrice * (1 + i * stepPct);
      if (priceLevel <= 0) continue;

      // Estimate liquidity at this price level from pool reserves
      let liquidityAtLevel = 0;
      for (const pool of pools) {
        const distFromCurrent = Math.abs(priceLevel - currentPrice) / currentPrice;
        // Liquidity is concentrated near current price in constant-product AMMs
        // Approximate with inverse-square decay
        const concentrationFactor = 1 / (1 + distFromCurrent * distFromCurrent * 100);
        liquidityAtLevel += pool.tvlUsd * concentrationFactor / numLevels;
      }

      totalLiquidity += liquidityAtLevel;
      priceLevels.push({
        priceLevel: Math.round(priceLevel * 100) / 100,
        liquidityUsd: Math.round(liquidityAtLevel * 100) / 100,
        pctOfTotal: 0, // filled below
        side: i < 0 ? 'bid' : 'ask',
      });
    }

    // Fill in percentages
    for (const level of priceLevels) {
      level.pctOfTotal = totalLiquidity > 0
        ? Math.round((level.liquidityUsd / totalLiquidity) * 10000) / 100
        : 0;
    }

    // Concentration score: how much of liquidity is within ±5% of current price
    const nearLiquidity = priceLevels
      .filter((l) => Math.abs(l.priceLevel - currentPrice) / currentPrice <= 0.05)
      .reduce((s, l) => s + l.liquidityUsd, 0);
    const concentrationScore = totalLiquidity > 0
      ? Math.round((nearLiquidity / totalLiquidity) * 100)
      : 0;

    return {
      pair: upper,
      currentPrice,
      levels: priceLevels,
      totalLiquidityUsd: Math.round(totalLiquidity * 100) / 100,
      concentrationScore,
      timestamp: isoNow(),
    };
  }

  // ─── Impermanent Loss Calculator ────────────────────────────────────

  /**
   * Calculate impermanent loss for given price change.
   */
  calculateImpermanentLoss(input: ImpermanentLossInput): ImpermanentLossResult {
    const priceRatioChange = input.currentPriceRatio / input.initialPriceRatio;
    const ilPct = computeImpermanentLoss(priceRatioChange);

    const holdValueUsd = input.depositValueUsd * (1 + priceRatioChange) / 2;
    const lpValueUsd = input.depositValueUsd * (1 + ilPct) * (1 + priceRatioChange) / 2;
    // More precisely: LP value uses the IL formula
    const actualLpValue = input.depositValueUsd * (2 * Math.sqrt(priceRatioChange)) / (1 + priceRatioChange);
    const ilUsd = holdValueUsd - actualLpValue > 0 ? holdValueUsd - actualLpValue : Math.abs(input.depositValueUsd * ilPct);

    // Fee earnings estimate (annualized → pro-rated)
    const feeAprPct = input.feeAprPct ?? 0;
    const feeEarningsUsd = input.depositValueUsd * (feeAprPct / 100);

    const netPnlUsd = feeEarningsUsd - ilUsd;

    // Break-even: days until fee earnings offset IL
    // Daily fee = depositValue * feeAprPct / 100 / 365
    const dailyFee = input.depositValueUsd * (feeAprPct / 100) / 365;
    const breakEvenDays = dailyFee > 0 && ilUsd > 0
      ? Math.ceil(ilUsd / dailyFee)
      : null;

    return {
      impermanentLossPct: Math.round(ilPct * 10000) / 100,
      impermanentLossUsd: Math.round(ilUsd * 100) / 100,
      holdValueUsd: Math.round(holdValueUsd * 100) / 100,
      lpValueUsd: Math.round(actualLpValue * 100) / 100,
      feeEarningsUsd: Math.round(feeEarningsUsd * 100) / 100,
      netPnlUsd: Math.round(netPnlUsd * 100) / 100,
      breakEvenDays,
      priceRatioChange: Math.round(priceRatioChange * 10000) / 10000,
    };
  }

  // ─── Pool Fee APR Estimation ────────────────────────────────────────

  /**
   * Estimate fee APR for pools of a given pair.
   */
  estimateApr(pair: string): PoolAprEstimate {
    const upper = pair.toUpperCase();
    const pools = this.pools.get(upper) ?? [];

    const poolEstimates = pools.map((pool) => {
      // APR = (dailyFee * 365) / TVL * 100
      const dailyFeeUsd = pool.volume24hUsd * pool.feeRate;
      const weeklyFeeUsd = dailyFeeUsd * 7;
      const monthlyFeeUsd = dailyFeeUsd * 30;
      const annualFeeUsd = dailyFeeUsd * 365;
      const feeAprPct = pool.tvlUsd > 0
        ? (annualFeeUsd / pool.tvlUsd) * 100
        : 0;

      return {
        poolId: pool.poolId,
        dex: pool.dex,
        feeAprPct: Math.round(feeAprPct * 100) / 100,
        volume24hUsd: pool.volume24hUsd,
        tvlUsd: pool.tvlUsd,
        dailyFeeUsd: Math.round(dailyFeeUsd * 100) / 100,
        weeklyFeeUsd: Math.round(weeklyFeeUsd * 100) / 100,
        monthlyFeeUsd: Math.round(monthlyFeeUsd * 100) / 100,
      };
    });

    // Sort by APR descending to find best pool
    const sorted = [...poolEstimates].sort((a, b) => b.feeAprPct - a.feeAprPct);
    const bestPool = sorted[0]?.poolId ?? '';
    const bestAprPct = sorted[0]?.feeAprPct ?? 0;

    return {
      pair: upper,
      pools: poolEstimates,
      bestPool,
      bestAprPct,
      timestamp: isoNow(),
    };
  }

  // ─── Best Execution Routing ─────────────────────────────────────────

  /**
   * Find the best execution route for a given trade.
   */
  findBestRoute(input: {
    inputToken: string;
    outputToken: string;
    amountUsd: number;
    maxSlippagePct?: number;
  }): RouteResult {
    const pair = `${input.inputToken.toUpperCase()}/${input.outputToken.toUpperCase()}`;
    const reversePair = `${input.outputToken.toUpperCase()}/${input.inputToken.toUpperCase()}`;

    let pools = this.pools.get(pair) ?? [];
    let reversed = false;
    if (pools.length === 0) {
      pools = this.pools.get(reversePair) ?? [];
      reversed = true;
    }

    const currentPrice = this.getCurrentPrice(pair) || this.getCurrentPrice(reversePair) || 1;
    const maxSlippage = input.maxSlippagePct ?? 5;

    const routes: ExecutionRoute[] = [];

    // Direct routes through each pool
    for (const pool of pools) {
      const amountIn = input.amountUsd / currentPrice;
      const reserveIn = reversed ? pool.reserveQuote : pool.reserveBase;
      const reserveOut = reversed ? pool.reserveBase : pool.reserveQuote;

      const result = computeAmmSlippage(reserveIn, reserveOut, amountIn, pool.feeRate);

      if (result.slippagePct > maxSlippage) continue;

      const feeUsd = input.amountUsd * pool.feeRate;
      const outputAmountUsd = result.amountOut * currentPrice;

      routes.push({
        steps: [{
          poolId: pool.poolId,
          dex: pool.dex,
          pair: pool.pair,
          inputToken: input.inputToken.toUpperCase(),
          outputToken: input.outputToken.toUpperCase(),
          inputAmount: input.amountUsd,
          outputAmount: Math.round(outputAmountUsd * 100) / 100,
          slippagePct: Math.round(result.slippagePct * 10000) / 10000,
          feeUsd: Math.round(feeUsd * 100) / 100,
        }],
        inputToken: input.inputToken.toUpperCase(),
        outputToken: input.outputToken.toUpperCase(),
        inputAmountUsd: input.amountUsd,
        outputAmountUsd: Math.round(outputAmountUsd * 100) / 100,
        totalSlippagePct: Math.round(result.slippagePct * 10000) / 10000,
        totalFeeUsd: Math.round(feeUsd * 100) / 100,
        effectivePrice: Math.round(result.effectivePrice * 100000) / 100000,
        savings: 0,
      });
    }

    // Sort by output (best route gives most output)
    routes.sort((a, b) => b.outputAmountUsd - a.outputAmountUsd);

    // Calculate savings vs worst route
    if (routes.length > 1) {
      const worstOutput = routes[routes.length - 1].outputAmountUsd;
      for (const route of routes) {
        route.savings = Math.round((route.outputAmountUsd - worstOutput) * 100) / 100;
      }
    }

    const bestRoute = routes[0] ?? this.createEmptyRoute(input);
    const alternativeRoutes = routes.slice(1);

    return {
      bestRoute,
      alternativeRoutes,
      timestamp: isoNow(),
    };
  }

  // ─── Historical Liquidity Tracking ──────────────────────────────────

  /**
   * Get historical liquidity snapshots for a pair.
   */
  getHistory(pair: string, limit?: number): LiquiditySnapshot[] {
    const upper = pair.toUpperCase();
    const snapshots = this.history.get(upper) ?? [];
    const effectiveLimit = limit ?? 50;
    return snapshots
      .slice(0, Math.min(effectiveLimit, MAX_HISTORY_PER_PAIR))
      .map((s) => structuredClone(s));
  }

  // ─── Private Methods ────────────────────────────────────────────────

  private getCurrentPrice(pair: string): number {
    const state = this.store.snapshot();
    // Try to find price from market state (use base token)
    const baseToken = pair.split('/')[0]?.toUpperCase() ?? pair.toUpperCase();
    return state.marketPricesUsd[baseToken] ?? 100; // default fallback
  }

  private recordSnapshot(pair: string, pools: PoolInfo[]): void {
    if (!this.history.has(pair)) {
      this.history.set(pair, []);
    }

    const totalTvl = pools.reduce((s, p) => s + p.tvlUsd, 0);
    const avgSlippageBps = this.computeAvgSlippage(pools);
    const concentrationScore = this.computeConcentration(pair, pools);

    const snapshot: LiquiditySnapshot = {
      pair,
      totalTvlUsd: Math.round(totalTvl * 100) / 100,
      poolCount: pools.length,
      avgSlippageBps: Math.round(avgSlippageBps * 100) / 100,
      concentrationScore,
      timestamp: isoNow(),
    };

    const pairHistory = this.history.get(pair)!;
    pairHistory.unshift(snapshot);
    if (pairHistory.length > MAX_HISTORY_PER_PAIR) {
      pairHistory.length = MAX_HISTORY_PER_PAIR;
    }
  }

  private computeAvgSlippage(pools: PoolInfo[]): number {
    if (pools.length === 0) return 0;

    let totalSlippage = 0;
    for (const pool of pools) {
      // Slippage for a reference $1000 trade
      const refTrade = 1000 / (pool.reserveQuote / pool.reserveBase || 100);
      const result = computeAmmSlippage(pool.reserveBase, pool.reserveQuote, refTrade, pool.feeRate);
      totalSlippage += result.slippagePct * 100; // in bps
    }

    return totalSlippage / pools.length;
  }

  private computeConcentration(pair: string, pools: PoolInfo[]): number {
    if (pools.length === 0) return 0;
    const totalTvl = pools.reduce((s, p) => s + p.tvlUsd, 0);
    if (totalTvl === 0) return 0;
    const maxPoolTvl = Math.max(...pools.map((p) => p.tvlUsd));
    // HHI-like: concentration is high if one pool dominates
    return Math.round((maxPoolTvl / totalTvl) * 100);
  }

  private createEmptyRoute(input: { inputToken: string; outputToken: string; amountUsd: number }): ExecutionRoute {
    return {
      steps: [],
      inputToken: input.inputToken.toUpperCase(),
      outputToken: input.outputToken.toUpperCase(),
      inputAmountUsd: input.amountUsd,
      outputAmountUsd: 0,
      totalSlippagePct: 0,
      totalFeeUsd: 0,
      effectivePrice: 0,
      savings: 0,
    };
  }

  /**
   * Seed some default pools for demonstration.
   */
  private seedDefaultPools(): void {
    const defaults: PoolInfo[] = [
      {
        poolId: 'raydium-sol-usdc-1',
        pair: 'SOL/USDC',
        dex: 'Raydium',
        reserveBase: 50_000,
        reserveQuote: 5_000_000,
        feeRate: 0.0025,
        volume24hUsd: 15_000_000,
        tvlUsd: 10_000_000,
        lastUpdated: isoNow(),
      },
      {
        poolId: 'orca-sol-usdc-1',
        pair: 'SOL/USDC',
        dex: 'Orca',
        reserveBase: 30_000,
        reserveQuote: 3_000_000,
        feeRate: 0.003,
        volume24hUsd: 8_000_000,
        tvlUsd: 6_000_000,
        lastUpdated: isoNow(),
      },
      {
        poolId: 'raydium-bonk-usdc-1',
        pair: 'BONK/USDC',
        dex: 'Raydium',
        reserveBase: 1_000_000_000,
        reserveQuote: 2_000_000,
        feeRate: 0.003,
        volume24hUsd: 5_000_000,
        tvlUsd: 4_000_000,
        lastUpdated: isoNow(),
      },
      {
        poolId: 'orca-bonk-usdc-1',
        pair: 'BONK/USDC',
        dex: 'Orca',
        reserveBase: 500_000_000,
        reserveQuote: 1_000_000,
        feeRate: 0.0025,
        volume24hUsd: 3_000_000,
        tvlUsd: 2_000_000,
        lastUpdated: isoNow(),
      },
      {
        poolId: 'raydium-jup-usdc-1',
        pair: 'JUP/USDC',
        dex: 'Raydium',
        reserveBase: 200_000,
        reserveQuote: 1_000_000,
        feeRate: 0.003,
        volume24hUsd: 4_000_000,
        tvlUsd: 2_000_000,
        lastUpdated: isoNow(),
      },
    ];

    for (const pool of defaults) {
      this.registerPool(pool);
    }
  }
}
