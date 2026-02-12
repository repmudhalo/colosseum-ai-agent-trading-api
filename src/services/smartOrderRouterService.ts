/**
 * Smart Order Router Service — optimal trade execution.
 *
 * Features:
 * - Multi-venue order routing (split orders across pools for best price)
 * - TWAP execution engine (time-weighted execution over configurable duration)
 * - VWAP execution engine (volume-weighted execution)
 * - Iceberg orders (break large orders into smaller chunks to minimize impact)
 * - Execution quality scoring (compare achieved price vs benchmark)
 * - Slippage prediction model (estimate slippage before execution)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VenueQuote {
  venueId: string;
  name: string;
  pair: string;
  bidPrice: number;
  askPrice: number;
  availableLiquidityUsd: number;
  feeRate: number;
  estimatedSlippagePct: number;
  latencyMs: number;
}

export interface RouteLeg {
  venueId: string;
  venueName: string;
  allocationPct: number;
  notionalUsd: number;
  estimatedPrice: number;
  estimatedSlippagePct: number;
  estimatedFeeUsd: number;
}

export interface OrderRoute {
  routeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  totalNotionalUsd: number;
  legs: RouteLeg[];
  estimatedAvgPrice: number;
  estimatedTotalSlippagePct: number;
  estimatedTotalFeeUsd: number;
  expectedSavingsUsd: number;
  createdAt: string;
}

export interface TwapOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  totalNotionalUsd: number;
  durationMs: number;
  intervalMs: number;
  slicesTotal: number;
  slicesExecuted: number;
  sliceNotionalUsd: number;
  executedNotionalUsd: number;
  avgExecutedPrice: number;
  status: 'active' | 'completed' | 'cancelled';
  slices: TwapSlice[];
  startedAt: string;
  updatedAt: string;
}

export interface TwapSlice {
  index: number;
  notionalUsd: number;
  price: number;
  executedAt: string;
}

export interface VwapOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  totalNotionalUsd: number;
  durationMs: number;
  bucketsTotal: number;
  bucketsExecuted: number;
  executedNotionalUsd: number;
  avgExecutedPrice: number;
  vwapPrice: number;
  status: 'active' | 'completed' | 'cancelled';
  buckets: VwapBucket[];
  startedAt: string;
  updatedAt: string;
}

export interface VwapBucket {
  index: number;
  volumeWeight: number;
  notionalUsd: number;
  price: number;
  executedAt: string;
}

export interface IcebergOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  totalNotionalUsd: number;
  visibleNotionalUsd: number;
  chunkSize: number;
  chunksTotal: number;
  chunksExecuted: number;
  executedNotionalUsd: number;
  avgExecutedPrice: number;
  status: 'active' | 'completed' | 'cancelled';
  chunks: IcebergChunk[];
  startedAt: string;
  updatedAt: string;
}

export interface IcebergChunk {
  index: number;
  notionalUsd: number;
  price: number;
  executedAt: string;
}

export interface ExecutionQualityScore {
  intentId: string;
  benchmarkPrice: number;
  executedPrice: number;
  slippageBps: number;
  implementationShortfallBps: number;
  marketImpactBps: number;
  timingCostBps: number;
  feesBps: number;
  totalCostBps: number;
  qualityRating: 'excellent' | 'good' | 'fair' | 'poor';
  score: number;  // 0-100
  timestamp: string;
}

export interface SlippageEstimate {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  estimatedSlippageBps: number;
  estimatedSlippagePct: number;
  estimatedSlippageUsd: number;
  confidence: number;            // 0-1
  model: string;
  factors: SlippageFactor[];
  timestamp: string;
}

export interface SlippageFactor {
  name: string;
  impactBps: number;
  weight: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TWAP_DEFAULT_INTERVAL_MS = 60_000;  // 1 minute slices
const VWAP_DEFAULT_BUCKETS = 10;
const ICEBERG_DEFAULT_CHUNK_PCT = 0.1;    // 10% visible
const SLIPPAGE_MODEL_VERSION = 'linear-v1';

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Estimate slippage based on order size relative to available liquidity.
 * Simple power-law model: slippage = k * (orderSize / liquidity) ^ alpha
 */
function estimateVenueSlippage(orderSizeUsd: number, liquidityUsd: number, alpha = 1.2): number {
  if (liquidityUsd <= 0) return 100;
  const ratio = orderSizeUsd / liquidityUsd;
  const k = 50; // base coefficient in bps
  return k * Math.pow(ratio, alpha);
}

/**
 * Generate a synthetic volume profile for VWAP buckets.
 * Models typical crypto U-shape: higher volume at start/end, lower in middle.
 */
function generateVolumeProfile(buckets: number): number[] {
  const profile: number[] = [];
  let total = 0;
  for (let i = 0; i < buckets; i++) {
    const t = i / (buckets - 1 || 1);
    // U-shape: higher at edges
    const weight = 1 + 0.8 * Math.pow(2 * t - 1, 2);
    profile.push(weight);
    total += weight;
  }
  // Normalize
  return profile.map((w) => w / total);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SmartOrderRouterService {
  private venues: Map<string, VenueQuote[]> = new Map();
  private twapOrders: Map<string, TwapOrder> = new Map();
  private vwapOrders: Map<string, VwapOrder> = new Map();
  private icebergOrders: Map<string, IcebergOrder> = new Map();
  private executionQualities: Map<string, ExecutionQualityScore> = new Map();
  private slippageHistory: Array<{ symbol: string; notionalUsd: number; actualSlippageBps: number; timestamp: string }> = [];

  constructor(private readonly store: StateStore) {
    this.seedDefaultVenues();
  }

  // ─── Multi-Venue Order Routing ──────────────────────────────────────

  /**
   * Find optimal route for an order across multiple venues.
   * Splits the order to minimize total slippage and fees.
   */
  routeOrder(input: {
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    maxSlippagePct?: number;
  }): OrderRoute {
    const symbol = input.symbol.toUpperCase();
    const venues = this.getVenuesForSymbol(symbol);
    const maxSlippage = input.maxSlippagePct ?? 5;

    if (venues.length === 0) {
      return this.createSingleVenueRoute(input, symbol);
    }

    // Sort venues by effective cost (slippage + fees)
    const scored = venues.map((v) => {
      const slippageBps = estimateVenueSlippage(input.notionalUsd, v.availableLiquidityUsd);
      const feeBps = v.feeRate * 10000;
      return { venue: v, totalCostBps: slippageBps + feeBps, slippageBps };
    }).sort((a, b) => a.totalCostBps - b.totalCostBps);

    // Greedy allocation: distribute order to cheapest venues first
    const legs: RouteLeg[] = [];
    let remaining = input.notionalUsd;
    let totalFee = 0;
    let weightedPrice = 0;
    let totalSlippage = 0;

    for (const { venue, slippageBps } of scored) {
      if (remaining <= 0) break;

      const slippagePct = slippageBps / 100;
      if (slippagePct > maxSlippage) continue;

      // Allocate up to 60% of venue's liquidity to avoid excessive impact
      const maxAllocation = venue.availableLiquidityUsd * 0.6;
      const allocation = Math.min(remaining, maxAllocation);

      if (allocation <= 0) continue;

      const price = input.side === 'buy' ? venue.askPrice : venue.bidPrice;
      const feeUsd = allocation * venue.feeRate;
      const allocationPct = allocation / input.notionalUsd;

      legs.push({
        venueId: venue.venueId,
        venueName: venue.name,
        allocationPct: Math.round(allocationPct * 10000) / 10000,
        notionalUsd: Math.round(allocation * 100) / 100,
        estimatedPrice: price,
        estimatedSlippagePct: Math.round(slippagePct * 10000) / 10000,
        estimatedFeeUsd: Math.round(feeUsd * 100) / 100,
      });

      weightedPrice += price * allocationPct;
      totalFee += feeUsd;
      totalSlippage += slippagePct * allocationPct;
      remaining -= allocation;
    }

    // If we couldn't route anything, fall back to single-venue estimate
    if (legs.length === 0) {
      return this.createSingleVenueRoute(input, symbol);
    }

    // Calculate savings vs worst single venue
    const worstVenue = scored[scored.length - 1];
    const worstCostUsd = input.notionalUsd * (worstVenue.totalCostBps / 10000);
    const actualCostUsd = totalFee + input.notionalUsd * (totalSlippage / 100);
    const savings = Math.max(0, worstCostUsd - actualCostUsd);

    const route: OrderRoute = {
      routeId: generateId('route'),
      symbol,
      side: input.side,
      totalNotionalUsd: input.notionalUsd,
      legs,
      estimatedAvgPrice: Math.round(weightedPrice * 100000) / 100000,
      estimatedTotalSlippagePct: Math.round(totalSlippage * 10000) / 10000,
      estimatedTotalFeeUsd: Math.round(totalFee * 100) / 100,
      expectedSavingsUsd: Math.round(savings * 100) / 100,
      createdAt: isoNow(),
    };

    return route;
  }

  // ─── TWAP Execution Engine ──────────────────────────────────────────

  /**
   * Start a TWAP (Time-Weighted Average Price) execution.
   * Splits order into equal time slices over the specified duration.
   */
  startTwap(input: {
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    durationMs: number;
    intervalMs?: number;
  }): TwapOrder {
    const symbol = input.symbol.toUpperCase();
    const intervalMs = input.intervalMs ?? TWAP_DEFAULT_INTERVAL_MS;
    const slicesTotal = Math.max(1, Math.floor(input.durationMs / intervalMs));
    const sliceNotional = input.notionalUsd / slicesTotal;
    const currentPrice = this.getCurrentPrice(symbol);

    // Simulate all slices immediately (in production, these would be scheduled)
    const slices: TwapSlice[] = [];
    let totalCost = 0;

    for (let i = 0; i < slicesTotal; i++) {
      // Add slight random price variation to simulate market movement
      const priceVariation = 1 + (Math.random() - 0.5) * 0.002;  // ±0.1%
      const slicePrice = currentPrice * priceVariation;
      slices.push({
        index: i,
        notionalUsd: Math.round(sliceNotional * 100) / 100,
        price: Math.round(slicePrice * 100000) / 100000,
        executedAt: new Date(Date.now() + i * intervalMs).toISOString(),
      });
      totalCost += sliceNotional / slicePrice;
    }

    const avgPrice = input.notionalUsd / totalCost;

    const order: TwapOrder = {
      orderId: generateId('twap'),
      symbol,
      side: input.side,
      totalNotionalUsd: input.notionalUsd,
      durationMs: input.durationMs,
      intervalMs,
      slicesTotal,
      slicesExecuted: slicesTotal,
      sliceNotionalUsd: Math.round(sliceNotional * 100) / 100,
      executedNotionalUsd: input.notionalUsd,
      avgExecutedPrice: Math.round(avgPrice * 100000) / 100000,
      status: 'completed',
      slices,
      startedAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.twapOrders.set(order.orderId, order);
    return structuredClone(order);
  }

  /**
   * Get a TWAP order by ID.
   */
  getTwapOrder(orderId: string): TwapOrder | null {
    const order = this.twapOrders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  // ─── VWAP Execution Engine ──────────────────────────────────────────

  /**
   * Start a VWAP (Volume-Weighted Average Price) execution.
   * Allocates slices proportional to expected volume profile.
   */
  startVwap(input: {
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    durationMs: number;
    buckets?: number;
  }): VwapOrder {
    const symbol = input.symbol.toUpperCase();
    const bucketsTotal = input.buckets ?? VWAP_DEFAULT_BUCKETS;
    const volumeProfile = generateVolumeProfile(bucketsTotal);
    const currentPrice = this.getCurrentPrice(symbol);
    const bucketIntervalMs = input.durationMs / bucketsTotal;

    const buckets: VwapBucket[] = [];
    let totalCost = 0;
    let totalExecuted = 0;

    for (let i = 0; i < bucketsTotal; i++) {
      const weight = volumeProfile[i];
      const bucketNotional = input.notionalUsd * weight;
      // Simulate price variation
      const priceVariation = 1 + (Math.random() - 0.5) * 0.003; // ±0.15%
      const bucketPrice = currentPrice * priceVariation;

      buckets.push({
        index: i,
        volumeWeight: Math.round(weight * 10000) / 10000,
        notionalUsd: Math.round(bucketNotional * 100) / 100,
        price: Math.round(bucketPrice * 100000) / 100000,
        executedAt: new Date(Date.now() + i * bucketIntervalMs).toISOString(),
      });

      totalCost += bucketNotional / bucketPrice;
      totalExecuted += bucketNotional;
    }

    const avgPrice = totalExecuted / totalCost;

    // Compute VWAP: volume-weighted average of bucket prices
    let vwapNum = 0;
    let vwapDen = 0;
    for (const bucket of buckets) {
      vwapNum += bucket.price * bucket.notionalUsd;
      vwapDen += bucket.notionalUsd;
    }
    const vwapPrice = vwapDen > 0 ? vwapNum / vwapDen : currentPrice;

    const order: VwapOrder = {
      orderId: generateId('vwap'),
      symbol,
      side: input.side,
      totalNotionalUsd: input.notionalUsd,
      durationMs: input.durationMs,
      bucketsTotal,
      bucketsExecuted: bucketsTotal,
      executedNotionalUsd: Math.round(totalExecuted * 100) / 100,
      avgExecutedPrice: Math.round(avgPrice * 100000) / 100000,
      vwapPrice: Math.round(vwapPrice * 100000) / 100000,
      status: 'completed',
      buckets,
      startedAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.vwapOrders.set(order.orderId, order);
    return structuredClone(order);
  }

  /**
   * Get a VWAP order by ID.
   */
  getVwapOrder(orderId: string): VwapOrder | null {
    const order = this.vwapOrders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  // ─── Iceberg Orders ─────────────────────────────────────────────────

  /**
   * Start an iceberg order: break a large order into smaller visible chunks.
   */
  startIceberg(input: {
    symbol: string;
    side: 'buy' | 'sell';
    totalNotionalUsd: number;
    visiblePct?: number;
    chunkSize?: number;
  }): IcebergOrder {
    const symbol = input.symbol.toUpperCase();
    const visiblePct = input.visiblePct ?? ICEBERG_DEFAULT_CHUNK_PCT;
    const chunkSize = input.chunkSize ?? Math.round(input.totalNotionalUsd * visiblePct * 100) / 100;
    const chunksTotal = Math.max(1, Math.ceil(input.totalNotionalUsd / chunkSize));
    const currentPrice = this.getCurrentPrice(symbol);

    const chunks: IcebergChunk[] = [];
    let totalCost = 0;
    let totalExecuted = 0;

    for (let i = 0; i < chunksTotal; i++) {
      const chunkNotional = Math.min(chunkSize, input.totalNotionalUsd - totalExecuted);
      if (chunkNotional <= 0) break;

      // Each chunk has slightly different execution price due to market movement
      const priceVariation = 1 + (Math.random() - 0.5) * 0.001; // ±0.05%
      const chunkPrice = currentPrice * priceVariation;

      chunks.push({
        index: i,
        notionalUsd: Math.round(chunkNotional * 100) / 100,
        price: Math.round(chunkPrice * 100000) / 100000,
        executedAt: new Date(Date.now() + i * 5000).toISOString(), // 5s between chunks
      });

      totalCost += chunkNotional / chunkPrice;
      totalExecuted += chunkNotional;
    }

    const avgPrice = totalExecuted > 0 ? totalExecuted / totalCost : currentPrice;

    const order: IcebergOrder = {
      orderId: generateId('iceberg'),
      symbol,
      side: input.side,
      totalNotionalUsd: input.totalNotionalUsd,
      visibleNotionalUsd: Math.round(chunkSize * 100) / 100,
      chunkSize: Math.round(chunkSize * 100) / 100,
      chunksTotal: chunks.length,
      chunksExecuted: chunks.length,
      executedNotionalUsd: Math.round(totalExecuted * 100) / 100,
      avgExecutedPrice: Math.round(avgPrice * 100000) / 100000,
      status: 'completed',
      chunks,
      startedAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.icebergOrders.set(order.orderId, order);
    return structuredClone(order);
  }

  /**
   * Get an iceberg order by ID.
   */
  getIcebergOrder(orderId: string): IcebergOrder | null {
    const order = this.icebergOrders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  // ─── Execution Quality Scoring ──────────────────────────────────────

  /**
   * Score execution quality by comparing achieved price vs benchmark.
   * Uses implementation shortfall framework.
   */
  scoreExecution(intentId: string): ExecutionQualityScore | null {
    // Check cache
    const cached = this.executionQualities.get(intentId);
    if (cached) return structuredClone(cached);

    // Look up execution from state
    const state = this.store.snapshot();
    const intent = state.tradeIntents[intentId];
    if (!intent) return null;

    const execution = Object.values(state.executions).find(
      (ex) => ex.intentId === intentId,
    );

    const benchmarkPrice = state.marketPricesUsd[intent.symbol] ?? 100;
    const executedPrice = execution?.priceUsd ?? benchmarkPrice * (1 + (Math.random() - 0.5) * 0.01);

    // Calculate components in basis points
    const priceDiffPct = Math.abs(executedPrice - benchmarkPrice) / benchmarkPrice;
    const slippageBps = Math.round(priceDiffPct * 10000);

    // Implementation shortfall decomposition
    const marketImpactBps = Math.round(slippageBps * 0.4);   // ~40% of total slippage
    const timingCostBps = Math.round(slippageBps * 0.3);      // ~30% timing
    const feesBps = Math.round(slippageBps * 0.2);            // ~20% fees
    const residualBps = slippageBps - marketImpactBps - timingCostBps - feesBps;
    const implementationShortfallBps = slippageBps + residualBps;
    const totalCostBps = implementationShortfallBps;

    // Quality rating
    let qualityRating: ExecutionQualityScore['qualityRating'];
    let score: number;
    if (totalCostBps <= 5) {
      qualityRating = 'excellent';
      score = 95 + Math.random() * 5;
    } else if (totalCostBps <= 20) {
      qualityRating = 'good';
      score = 75 + Math.random() * 20;
    } else if (totalCostBps <= 50) {
      qualityRating = 'fair';
      score = 50 + Math.random() * 25;
    } else {
      qualityRating = 'poor';
      score = Math.max(0, 50 - totalCostBps / 10);
    }

    const quality: ExecutionQualityScore = {
      intentId,
      benchmarkPrice: Math.round(benchmarkPrice * 100000) / 100000,
      executedPrice: Math.round(executedPrice * 100000) / 100000,
      slippageBps,
      implementationShortfallBps,
      marketImpactBps,
      timingCostBps,
      feesBps,
      totalCostBps,
      qualityRating,
      score: Math.round(score * 100) / 100,
      timestamp: isoNow(),
    };

    this.executionQualities.set(intentId, quality);
    return structuredClone(quality);
  }

  // ─── Slippage Prediction Model ──────────────────────────────────────

  /**
   * Predict slippage before execution based on order characteristics
   * and historical data.
   */
  predictSlippage(input: {
    symbol: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
  }): SlippageEstimate {
    const symbol = input.symbol.toUpperCase();
    const currentPrice = this.getCurrentPrice(symbol);
    const venues = this.getVenuesForSymbol(symbol);

    // Factor 1: Order size relative to liquidity
    const totalLiquidity = venues.reduce((s, v) => s + v.availableLiquidityUsd, 0) || 1_000_000;
    const sizeRatio = input.notionalUsd / totalLiquidity;
    const sizeImpactBps = Math.round(sizeRatio * 5000); // 50bps per 1% of liquidity

    // Factor 2: Spread cost
    const avgSpreadBps = venues.length > 0
      ? venues.reduce((s, v) => {
          const spread = v.askPrice > 0 ? ((v.askPrice - v.bidPrice) / v.askPrice) * 10000 : 10;
          return s + spread;
        }, 0) / venues.length
      : 15;
    const spreadCostBps = Math.round(avgSpreadBps / 2); // half-spread

    // Factor 3: Historical slippage for similar orders
    const historicalOrders = this.slippageHistory.filter(
      (h) => h.symbol === symbol && Math.abs(h.notionalUsd - input.notionalUsd) / input.notionalUsd < 0.5,
    );
    const historicalBps = historicalOrders.length > 0
      ? Math.round(historicalOrders.reduce((s, h) => s + h.actualSlippageBps, 0) / historicalOrders.length)
      : 0;

    // Factor 4: Venue count / fragmentation
    const venueCountFactor = venues.length > 3 ? -2 : venues.length > 1 ? 0 : 5;

    // Combine factors
    const factors: SlippageFactor[] = [
      { name: 'order_size_impact', impactBps: sizeImpactBps, weight: 0.4 },
      { name: 'spread_cost', impactBps: spreadCostBps, weight: 0.25 },
      { name: 'historical_slippage', impactBps: historicalBps, weight: 0.2 },
      { name: 'venue_fragmentation', impactBps: venueCountFactor, weight: 0.15 },
    ];

    const totalSlippageBps = Math.max(0, Math.round(
      factors.reduce((s, f) => s + f.impactBps * f.weight, 0),
    ));

    const slippagePct = totalSlippageBps / 100;
    const slippageUsd = input.notionalUsd * (slippagePct / 100);

    // Confidence based on data availability
    const confidence = Math.min(1, 0.5 + venues.length * 0.1 + historicalOrders.length * 0.05);

    // Record for future predictions
    this.slippageHistory.push({
      symbol,
      notionalUsd: input.notionalUsd,
      actualSlippageBps: totalSlippageBps,
      timestamp: isoNow(),
    });

    // Keep history bounded
    if (this.slippageHistory.length > 1000) {
      this.slippageHistory = this.slippageHistory.slice(-500);
    }

    return {
      symbol,
      side: input.side,
      notionalUsd: input.notionalUsd,
      estimatedSlippageBps: totalSlippageBps,
      estimatedSlippagePct: Math.round(slippagePct * 10000) / 10000,
      estimatedSlippageUsd: Math.round(slippageUsd * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      model: SLIPPAGE_MODEL_VERSION,
      factors,
      timestamp: isoNow(),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private getCurrentPrice(symbol: string): number {
    const state = this.store.snapshot();
    return state.marketPricesUsd[symbol] ?? 100;
  }

  private getVenuesForSymbol(symbol: string): VenueQuote[] {
    return this.venues.get(symbol.toUpperCase()) ?? [];
  }

  private createSingleVenueRoute(
    input: { symbol: string; side: 'buy' | 'sell'; notionalUsd: number },
    symbol: string,
  ): OrderRoute {
    const currentPrice = this.getCurrentPrice(symbol);
    const estimatedSlippage = estimateVenueSlippage(input.notionalUsd, 1_000_000) / 100;
    const estimatedFee = input.notionalUsd * 0.003;

    return {
      routeId: generateId('route'),
      symbol,
      side: input.side,
      totalNotionalUsd: input.notionalUsd,
      legs: [{
        venueId: 'default',
        venueName: 'Default Pool',
        allocationPct: 1,
        notionalUsd: input.notionalUsd,
        estimatedPrice: currentPrice,
        estimatedSlippagePct: Math.round(estimatedSlippage * 10000) / 10000,
        estimatedFeeUsd: Math.round(estimatedFee * 100) / 100,
      }],
      estimatedAvgPrice: currentPrice,
      estimatedTotalSlippagePct: Math.round(estimatedSlippage * 10000) / 10000,
      estimatedTotalFeeUsd: Math.round(estimatedFee * 100) / 100,
      expectedSavingsUsd: 0,
      createdAt: isoNow(),
    };
  }

  /**
   * Seed default venue quotes for common symbols.
   */
  private seedDefaultVenues(): void {
    const solVenues: VenueQuote[] = [
      {
        venueId: 'raydium-sol',
        name: 'Raydium SOL/USDC',
        pair: 'SOL/USDC',
        bidPrice: 99.85,
        askPrice: 100.15,
        availableLiquidityUsd: 5_000_000,
        feeRate: 0.0025,
        estimatedSlippagePct: 0.05,
        latencyMs: 50,
      },
      {
        venueId: 'orca-sol',
        name: 'Orca SOL/USDC',
        pair: 'SOL/USDC',
        bidPrice: 99.90,
        askPrice: 100.10,
        availableLiquidityUsd: 3_000_000,
        feeRate: 0.003,
        estimatedSlippagePct: 0.04,
        latencyMs: 45,
      },
      {
        venueId: 'jupiter-sol',
        name: 'Jupiter SOL/USDC',
        pair: 'SOL/USDC',
        bidPrice: 99.88,
        askPrice: 100.12,
        availableLiquidityUsd: 8_000_000,
        feeRate: 0.002,
        estimatedSlippagePct: 0.03,
        latencyMs: 60,
      },
    ];

    const bonkVenues: VenueQuote[] = [
      {
        venueId: 'raydium-bonk',
        name: 'Raydium BONK/USDC',
        pair: 'BONK/USDC',
        bidPrice: 0.00198,
        askPrice: 0.00202,
        availableLiquidityUsd: 2_000_000,
        feeRate: 0.003,
        estimatedSlippagePct: 0.1,
        latencyMs: 55,
      },
      {
        venueId: 'orca-bonk',
        name: 'Orca BONK/USDC',
        pair: 'BONK/USDC',
        bidPrice: 0.00199,
        askPrice: 0.00201,
        availableLiquidityUsd: 1_500_000,
        feeRate: 0.0025,
        estimatedSlippagePct: 0.08,
        latencyMs: 50,
      },
    ];

    this.venues.set('SOL', solVenues);
    this.venues.set('BONK', bonkVenues);
  }
}
