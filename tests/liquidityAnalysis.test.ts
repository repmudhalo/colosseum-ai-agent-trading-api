import { describe, expect, it, beforeEach } from 'vitest';
import {
  LiquidityAnalysisService,
  PoolInfo,
  ImpermanentLossInput,
} from '../src/services/liquidityAnalysisService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { vi } from 'vitest';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

describe('LiquidityAnalysisService', () => {
  let service: LiquidityAnalysisService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BONK'] = 0.002;
    state.marketPricesUsd['JUP'] = 5;
    const store = createMockStore(state);
    service = new LiquidityAnalysisService(store);
  });

  // ─── Pool Registration ──────────────────────────────────────────────

  it('seeds default pools on construction', () => {
    const solPools = service.getPools('SOL/USDC');
    expect(solPools.length).toBeGreaterThanOrEqual(2);
    expect(solPools.some((p) => p.dex === 'Raydium')).toBe(true);
    expect(solPools.some((p) => p.dex === 'Orca')).toBe(true);
  });

  it('registers and retrieves custom pools', () => {
    const pool: PoolInfo = {
      poolId: 'custom-pool-1',
      pair: 'PYTH/USDC',
      dex: 'CustomDex',
      reserveBase: 100_000,
      reserveQuote: 500_000,
      feeRate: 0.002,
      volume24hUsd: 1_000_000,
      tvlUsd: 1_000_000,
      lastUpdated: new Date().toISOString(),
    };

    const registered = service.registerPool(pool);
    expect(registered.poolId).toBe('custom-pool-1');
    expect(registered.pair).toBe('PYTH/USDC');

    const pools = service.getPools('PYTH/USDC');
    expect(pools.length).toBe(1);
    expect(pools[0].dex).toBe('CustomDex');
  });

  it('normalizes pair to uppercase', () => {
    const pools = service.getPools('sol/usdc');
    expect(pools.length).toBeGreaterThan(0);
    expect(pools[0].pair).toBe('SOL/USDC');
  });

  // ─── Pool Depth Analysis ────────────────────────────────────────────

  it('returns depth analysis with slippage buckets', () => {
    const depth = service.analyzeDepth('SOL/USDC');
    expect(depth.pair).toBe('SOL/USDC');
    expect(depth.currentPrice).toBe(100);
    expect(depth.pools.length).toBeGreaterThanOrEqual(2);
    expect(depth.aggregatedDepth.length).toBeGreaterThan(0);
    expect(depth.timestamp).toBeDefined();

    // Each pool should have slippage buckets
    for (const pool of depth.pools) {
      expect(pool.slippageBuckets.length).toBeGreaterThan(0);
      for (const bucket of pool.slippageBuckets) {
        expect(bucket.tradeSizeUsd).toBeGreaterThan(0);
        expect(bucket.slippagePct).toBeGreaterThanOrEqual(0);
        expect(bucket.effectivePrice).toBeGreaterThan(0);
      }
    }
  });

  it('larger trades produce higher slippage', () => {
    const depth = service.analyzeDepth('SOL/USDC');
    const buckets = depth.pools[0].slippageBuckets;

    // Slippage should generally increase with trade size
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].slippagePct).toBeGreaterThanOrEqual(buckets[i - 1].slippagePct);
    }
  });

  it('accepts custom trade sizes', () => {
    const customSizes = [50, 200, 1000];
    const depth = service.analyzeDepth('SOL/USDC', customSizes);
    expect(depth.aggregatedDepth.length).toBe(3);
    expect(depth.aggregatedDepth.map((b) => b.tradeSizeUsd)).toEqual(customSizes);
  });

  it('handles pairs with no pools gracefully', () => {
    const depth = service.analyzeDepth('UNKNOWN/PAIR');
    expect(depth.pair).toBe('UNKNOWN/PAIR');
    expect(depth.pools.length).toBe(0);
    expect(depth.aggregatedDepth.length).toBeGreaterThan(0);
    expect(depth.aggregatedDepth.every((b) => b.slippagePct === 0)).toBe(true);
  });

  // ─── Liquidity Heatmap ──────────────────────────────────────────────

  it('generates liquidity heatmap with bid/ask sides', () => {
    const heatmap = service.getHeatmap('SOL/USDC');
    expect(heatmap.pair).toBe('SOL/USDC');
    expect(heatmap.currentPrice).toBe(100);
    expect(heatmap.levels.length).toBeGreaterThan(0);
    expect(heatmap.totalLiquidityUsd).toBeGreaterThan(0);
    expect(heatmap.concentrationScore).toBeGreaterThanOrEqual(0);
    expect(heatmap.concentrationScore).toBeLessThanOrEqual(100);

    const bids = heatmap.levels.filter((l) => l.side === 'bid');
    const asks = heatmap.levels.filter((l) => l.side === 'ask');
    expect(bids.length).toBeGreaterThan(0);
    expect(asks.length).toBeGreaterThan(0);
  });

  it('heatmap percentages sum to ~100%', () => {
    const heatmap = service.getHeatmap('SOL/USDC');
    const totalPct = heatmap.levels.reduce((s, l) => s + l.pctOfTotal, 0);
    expect(totalPct).toBeGreaterThan(95);
    expect(totalPct).toBeLessThan(105);
  });

  it('heatmap shows higher liquidity near current price', () => {
    const heatmap = service.getHeatmap('SOL/USDC');
    const nearLevels = heatmap.levels.filter((l) =>
      Math.abs(l.priceLevel - heatmap.currentPrice) / heatmap.currentPrice <= 0.05
    );
    const farLevels = heatmap.levels.filter((l) =>
      Math.abs(l.priceLevel - heatmap.currentPrice) / heatmap.currentPrice > 0.3
    );

    if (nearLevels.length > 0 && farLevels.length > 0) {
      const avgNear = nearLevels.reduce((s, l) => s + l.liquidityUsd, 0) / nearLevels.length;
      const avgFar = farLevels.reduce((s, l) => s + l.liquidityUsd, 0) / farLevels.length;
      expect(avgNear).toBeGreaterThan(avgFar);
    }
  });

  // ─── Impermanent Loss Calculator ────────────────────────────────────

  it('calculates zero IL when price unchanged', () => {
    const result = service.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 1,
      depositValueUsd: 10000,
    });

    expect(result.impermanentLossPct).toBe(0);
    expect(result.impermanentLossUsd).toBe(0);
    expect(result.priceRatioChange).toBe(1);
  });

  it('calculates IL for 2x price increase', () => {
    const result = service.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 2,
      depositValueUsd: 10000,
    });

    // IL for 2x price change ≈ -5.72%
    expect(result.impermanentLossPct).toBeLessThan(0);
    expect(result.impermanentLossPct).toBeGreaterThan(-10);
    expect(result.impermanentLossUsd).toBeGreaterThan(0);
    expect(result.holdValueUsd).toBeGreaterThan(result.lpValueUsd);
    expect(result.priceRatioChange).toBe(2);
  });

  it('calculates IL with fee APR offset', () => {
    const result = service.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 1.5,
      depositValueUsd: 10000,
      feeAprPct: 50,
    });

    expect(result.feeEarningsUsd).toBeGreaterThan(0);
    expect(result.breakEvenDays).toBeGreaterThan(0);
    // With high APR, net PnL should be positive
    expect(result.netPnlUsd).toBeGreaterThan(0);
  });

  it('returns null breakEvenDays when no fee APR', () => {
    const result = service.calculateImpermanentLoss({
      initialPriceRatio: 1,
      currentPriceRatio: 2,
      depositValueUsd: 10000,
    });

    expect(result.breakEvenDays).toBeNull();
  });

  // ─── Pool Fee APR Estimation ────────────────────────────────────────

  it('estimates APR for all pools of a pair', () => {
    const apr = service.estimateApr('SOL/USDC');
    expect(apr.pair).toBe('SOL/USDC');
    expect(apr.pools.length).toBeGreaterThanOrEqual(2);
    expect(apr.bestPool).toBeDefined();
    expect(apr.bestAprPct).toBeGreaterThan(0);

    for (const pool of apr.pools) {
      expect(pool.feeAprPct).toBeGreaterThanOrEqual(0);
      expect(pool.dailyFeeUsd).toBeGreaterThanOrEqual(0);
      expect(pool.weeklyFeeUsd).toBeGreaterThanOrEqual(0);
      expect(pool.monthlyFeeUsd).toBeGreaterThanOrEqual(0);
      expect(pool.weeklyFeeUsd).toBeCloseTo(pool.dailyFeeUsd * 7, 0);
    }
  });

  it('identifies pool with highest APR', () => {
    const apr = service.estimateApr('SOL/USDC');
    const bestPoolData = apr.pools.find((p) => p.poolId === apr.bestPool);
    expect(bestPoolData).toBeDefined();

    // Best APR should match the best pool's APR
    expect(bestPoolData!.feeAprPct).toBe(apr.bestAprPct);

    // All other pools should have lower or equal APR
    for (const pool of apr.pools) {
      expect(pool.feeAprPct).toBeLessThanOrEqual(apr.bestAprPct);
    }
  });

  it('returns empty results for unknown pairs', () => {
    const apr = service.estimateApr('UNKNOWN/PAIR');
    expect(apr.pools.length).toBe(0);
    expect(apr.bestPool).toBe('');
    expect(apr.bestAprPct).toBe(0);
  });

  // ─── Best Execution Routing ─────────────────────────────────────────

  it('finds best execution route', () => {
    const result = service.findBestRoute({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 1000,
    });

    expect(result.bestRoute).toBeDefined();
    expect(result.bestRoute.steps.length).toBeGreaterThan(0);
    expect(result.bestRoute.inputToken).toBe('SOL');
    expect(result.bestRoute.outputToken).toBe('USDC');
    expect(result.bestRoute.inputAmountUsd).toBe(1000);
    expect(result.bestRoute.outputAmountUsd).toBeGreaterThan(0);
    expect(result.bestRoute.totalSlippagePct).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeDefined();
  });

  it('returns multiple alternative routes', () => {
    const result = service.findBestRoute({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 1000,
    });

    expect(result.alternativeRoutes.length).toBeGreaterThan(0);

    // Best route should have highest output
    for (const alt of result.alternativeRoutes) {
      expect(result.bestRoute.outputAmountUsd).toBeGreaterThanOrEqual(alt.outputAmountUsd);
    }
  });

  it('calculates savings vs worst route', () => {
    const result = service.findBestRoute({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 1000,
    });

    if (result.alternativeRoutes.length > 0) {
      expect(result.bestRoute.savings).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects maxSlippagePct filter', () => {
    const result = service.findBestRoute({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amountUsd: 1000,
      maxSlippagePct: 0.001, // very tight
    });

    // Routes found should all be within slippage tolerance
    const allRoutes = [result.bestRoute, ...result.alternativeRoutes];
    for (const route of allRoutes) {
      if (route.steps.length > 0) {
        expect(route.totalSlippagePct).toBeLessThanOrEqual(0.001);
      }
    }
  });

  it('returns empty route for unknown token pairs', () => {
    const result = service.findBestRoute({
      inputToken: 'UNKNOWN1',
      outputToken: 'UNKNOWN2',
      amountUsd: 1000,
    });

    expect(result.bestRoute.steps.length).toBe(0);
    expect(result.bestRoute.outputAmountUsd).toBe(0);
  });

  // ─── Historical Liquidity Tracking ──────────────────────────────────

  it('records liquidity snapshots on depth analysis', () => {
    // Run analysis to generate snapshots
    service.analyzeDepth('SOL/USDC');
    service.analyzeDepth('SOL/USDC');
    service.analyzeDepth('SOL/USDC');

    const history = service.getHistory('SOL/USDC');
    expect(history.length).toBe(3);
    expect(history[0].pair).toBe('SOL/USDC');
    expect(history[0].totalTvlUsd).toBeGreaterThan(0);
    expect(history[0].poolCount).toBeGreaterThan(0);
    expect(history[0].timestamp).toBeDefined();
  });

  it('respects limit on history retrieval', () => {
    for (let i = 0; i < 10; i++) {
      service.analyzeDepth('SOL/USDC');
    }

    const history = service.getHistory('SOL/USDC', 3);
    expect(history.length).toBe(3);
  });

  it('orders history with most recent first', () => {
    service.analyzeDepth('SOL/USDC');
    service.analyzeDepth('SOL/USDC');

    const history = service.getHistory('SOL/USDC');
    expect(history.length).toBe(2);
    expect(new Date(history[0].timestamp).getTime())
      .toBeGreaterThanOrEqual(new Date(history[1].timestamp).getTime());
  });

  it('returns empty history for unknown pair', () => {
    const history = service.getHistory('UNKNOWN/PAIR');
    expect(history).toEqual([]);
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────

  it('handles IL calculation with equal price ratios', () => {
    const result = service.calculateImpermanentLoss({
      initialPriceRatio: 5,
      currentPriceRatio: 5,
      depositValueUsd: 50000,
    });

    expect(result.impermanentLossPct).toBe(0);
    expect(result.priceRatioChange).toBe(1);
  });

  it('updates existing pool on re-registration', () => {
    const pool: PoolInfo = {
      poolId: 'raydium-sol-usdc-1', // existing pool
      pair: 'SOL/USDC',
      dex: 'Raydium',
      reserveBase: 100_000, // updated reserves
      reserveQuote: 10_000_000,
      feeRate: 0.002,
      volume24hUsd: 20_000_000,
      tvlUsd: 20_000_000,
      lastUpdated: new Date().toISOString(),
    };

    service.registerPool(pool);
    const pools = service.getPools('SOL/USDC');
    // Should not duplicate - still 2 pools for SOL/USDC
    const raydiumPools = pools.filter((p) => p.poolId === 'raydium-sol-usdc-1');
    expect(raydiumPools.length).toBe(1);
    expect(raydiumPools[0].tvlUsd).toBe(20_000_000);
  });
});
