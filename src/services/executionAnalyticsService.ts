/**
 * Execution Analytics Dashboard Data Service.
 *
 * Provides granular execution analytics for dashboard charting:
 * - Timeline of executions for time-series charts
 * - Slippage analysis (expected vs actual)
 * - Volume profiles by price level
 * - Execution quality metrics (VWAP, fill rates)
 * - System-wide latency percentiles
 */

import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TimelinePoint {
  executionId: string;
  timestamp: string;
  symbol: string;
  side: 'buy' | 'sell';
  priceUsd: number;
  quantity: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number;
  cumulativePnlUsd: number;
  mode: string;
}

export interface ExecutionTimeline {
  agentId: string;
  points: TimelinePoint[];
  totalExecutions: number;
  firstExecution: string | null;
  lastExecution: string | null;
}

export interface SlippageEntry {
  executionId: string;
  symbol: string;
  side: 'buy' | 'sell';
  expectedPriceUsd: number;
  actualPriceUsd: number;
  slippagePct: number;
  slippageUsd: number;
  timestamp: string;
}

export interface SlippageAnalysis {
  agentId: string;
  entries: SlippageEntry[];
  avgSlippagePct: number;
  maxSlippagePct: number;
  totalSlippageCostUsd: number;
  positiveSlippageCount: number;
  negativeSlippageCount: number;
  zeroSlippageCount: number;
}

export interface VolumeLevel {
  priceBucket: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  tradeCount: number;
}

export interface VolumeProfile {
  symbol: string;
  levels: VolumeLevel[];
  pocPrice: number;
  totalVolume: number;
  bucketSizeUsd: number;
}

export interface ExecutionQuality {
  agentId: string;
  totalExecutions: number;
  filledCount: number;
  failedCount: number;
  fillRate: number;
  vwapComparison: {
    agentVwap: number;
    marketVwap: number;
    outperformancePct: number;
  } | null;
  avgFeeUsd: number;
  totalFeesUsd: number;
  avgNotionalUsd: number;
  symbolBreakdown: Array<{
    symbol: string;
    tradeCount: number;
    totalNotionalUsd: number;
    avgPriceUsd: number;
    fillRate: number;
  }>;
}

export interface LatencyMetrics {
  asOf: string;
  totalSamples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  histogram: Array<{ bucketMs: string; count: number }>;
}

// ─── Service ────────────────────────────────────────────────────────────

export class ExecutionAnalyticsService {
  private latencySamples: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 10_000;

  constructor(private readonly store: StateStore) {}

  recordLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > ExecutionAnalyticsService.MAX_LATENCY_SAMPLES) {
      this.latencySamples = this.latencySamples.slice(-ExecutionAnalyticsService.MAX_LATENCY_SAMPLES);
    }
  }

  getExecutionTimeline(agentId: string): ExecutionTimeline {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let cumulativePnl = 0;
    const points: TimelinePoint[] = executions.map((ex) => {
      cumulativePnl += ex.realizedPnlUsd;
      return {
        executionId: ex.id, timestamp: ex.createdAt, symbol: ex.symbol, side: ex.side,
        priceUsd: ex.priceUsd, quantity: ex.quantity, notionalUsd: ex.grossNotionalUsd,
        feeUsd: ex.feeUsd, realizedPnlUsd: ex.realizedPnlUsd,
        cumulativePnlUsd: Number(cumulativePnl.toFixed(4)), mode: ex.mode,
      };
    });

    return {
      agentId, points, totalExecutions: points.length,
      firstExecution: points.length > 0 ? points[0].timestamp : null,
      lastExecution: points.length > 0 ? points[points.length - 1].timestamp : null,
    };
  }

  getSlippageAnalysis(agentId: string): SlippageAnalysis {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const entries: SlippageEntry[] = executions.map((ex) => {
      const marketPrice = state.marketPricesUsd[ex.symbol] ?? ex.priceUsd;
      const slippageUsd = ex.side === 'buy' ? ex.priceUsd - marketPrice : marketPrice - ex.priceUsd;
      const slippagePct = marketPrice > 0 ? Number(((slippageUsd / marketPrice) * 100).toFixed(4)) : 0;
      return {
        executionId: ex.id, symbol: ex.symbol, side: ex.side,
        expectedPriceUsd: marketPrice, actualPriceUsd: ex.priceUsd,
        slippagePct, slippageUsd: Number(slippageUsd.toFixed(4)), timestamp: ex.createdAt,
      };
    });

    const avgSlippagePct = entries.length > 0 ? Number((entries.reduce((sum, e) => sum + e.slippagePct, 0) / entries.length).toFixed(4)) : 0;
    const maxSlippagePct = entries.length > 0 ? Number(Math.max(...entries.map((e) => Math.abs(e.slippagePct))).toFixed(4)) : 0;
    const totalSlippageCostUsd = Number(entries.reduce((sum, e) => sum + e.slippageUsd, 0).toFixed(4));

    return {
      agentId, entries, avgSlippagePct, maxSlippagePct, totalSlippageCostUsd,
      positiveSlippageCount: entries.filter((e) => e.slippagePct > 0).length,
      negativeSlippageCount: entries.filter((e) => e.slippagePct < 0).length,
      zeroSlippageCount: entries.filter((e) => e.slippagePct === 0).length,
    };
  }

  getVolumeProfile(symbol: string): VolumeProfile {
    const state = this.store.snapshot();
    const normalizedSymbol = symbol.toUpperCase();
    const executions = Object.values(state.executions).filter((ex) => ex.symbol === normalizedSymbol && ex.status === 'filled');

    if (executions.length === 0) return { symbol: normalizedSymbol, levels: [], pocPrice: 0, totalVolume: 0, bucketSizeUsd: 0 };

    const prices = executions.map((ex) => ex.priceUsd);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice;
    const bucketSizeUsd = range > 0 ? Number(Math.max(range / 20, 0.01).toFixed(4)) : 1;

    const levelMap = new Map<number, VolumeLevel>();
    for (const ex of executions) {
      const bucket = Number((Math.floor(ex.priceUsd / bucketSizeUsd) * bucketSizeUsd).toFixed(4));
      const level = levelMap.get(bucket) ?? { priceBucket: bucket, buyVolume: 0, sellVolume: 0, totalVolume: 0, tradeCount: 0 };
      if (ex.side === 'buy') level.buyVolume += ex.grossNotionalUsd;
      else level.sellVolume += ex.grossNotionalUsd;
      level.totalVolume += ex.grossNotionalUsd;
      level.tradeCount += 1;
      levelMap.set(bucket, level);
    }

    const levels = Array.from(levelMap.values())
      .map((l) => ({ ...l, buyVolume: Number(l.buyVolume.toFixed(4)), sellVolume: Number(l.sellVolume.toFixed(4)), totalVolume: Number(l.totalVolume.toFixed(4)) }))
      .sort((a, b) => a.priceBucket - b.priceBucket);
    const poc = levels.reduce((max, l) => (l.totalVolume > max.totalVolume ? l : max), levels[0]);
    const totalVolume = Number(levels.reduce((sum, l) => sum + l.totalVolume, 0).toFixed(4));

    return { symbol: normalizedSymbol, levels, pocPrice: poc.priceBucket, totalVolume, bucketSizeUsd };
  }

  getExecutionQuality(agentId: string): ExecutionQuality {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');

    const allExecs = Object.values(state.executions).filter((ex) => ex.agentId === agentId);
    const filled = allExecs.filter((ex) => ex.status === 'filled');
    const failed = allExecs.filter((ex) => ex.status === 'failed');
    const fillRate = allExecs.length > 0 ? Number((filled.length / allExecs.length).toFixed(4)) : 0;

    let vwapComparison: ExecutionQuality['vwapComparison'] = null;
    if (filled.length > 0) {
      const totalQtyWeightedPrice = filled.reduce((sum, ex) => sum + ex.priceUsd * ex.quantity, 0);
      const totalQty = filled.reduce((sum, ex) => sum + ex.quantity, 0);
      const agentVwap = totalQty > 0 ? Number((totalQtyWeightedPrice / totalQty).toFixed(4)) : 0;

      const symbolPrices = new Map<string, number>();
      for (const ex of filled) if (!symbolPrices.has(ex.symbol)) symbolPrices.set(ex.symbol, state.marketPricesUsd[ex.symbol] ?? ex.priceUsd);

      const marketQtyWeightedPrice = filled.reduce((sum, ex) => sum + (symbolPrices.get(ex.symbol) ?? ex.priceUsd) * ex.quantity, 0);
      const marketVwap = totalQty > 0 ? Number((marketQtyWeightedPrice / totalQty).toFixed(4)) : 0;
      const outperformancePct = marketVwap > 0 ? Number((((marketVwap - agentVwap) / marketVwap) * 100).toFixed(4)) : 0;
      vwapComparison = { agentVwap, marketVwap, outperformancePct };
    }

    const totalFeesUsd = Number(filled.reduce((sum, ex) => sum + ex.feeUsd, 0).toFixed(4));
    const avgFeeUsd = filled.length > 0 ? Number((totalFeesUsd / filled.length).toFixed(4)) : 0;
    const avgNotionalUsd = filled.length > 0 ? Number((filled.reduce((sum, ex) => sum + ex.grossNotionalUsd, 0) / filled.length).toFixed(4)) : 0;

    const symbolMap = new Map<string, { tradeCount: number; totalNotionalUsd: number; totalPrice: number; filled: number; total: number }>();
    for (const ex of allExecs) {
      const entry = symbolMap.get(ex.symbol) ?? { tradeCount: 0, totalNotionalUsd: 0, totalPrice: 0, filled: 0, total: 0 };
      entry.total += 1;
      if (ex.status === 'filled') { entry.tradeCount += 1; entry.totalNotionalUsd += ex.grossNotionalUsd; entry.totalPrice += ex.priceUsd; entry.filled += 1; }
      symbolMap.set(ex.symbol, entry);
    }
    const symbolBreakdown = Array.from(symbolMap.entries()).map(([sym, data]) => ({
      symbol: sym, tradeCount: data.tradeCount, totalNotionalUsd: Number(data.totalNotionalUsd.toFixed(4)),
      avgPriceUsd: data.tradeCount > 0 ? Number((data.totalPrice / data.tradeCount).toFixed(4)) : 0,
      fillRate: data.total > 0 ? Number((data.filled / data.total).toFixed(4)) : 0,
    }));

    return { agentId, totalExecutions: allExecs.length, filledCount: filled.length, failedCount: failed.length, fillRate, vwapComparison, avgFeeUsd, totalFeesUsd, avgNotionalUsd, symbolBreakdown };
  }

  getLatencyMetrics(): LatencyMetrics {
    const now = new Date().toISOString();
    if (this.latencySamples.length === 0) return { asOf: now, totalSamples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, avgMs: 0, minMs: 0, maxMs: 0, histogram: [] };

    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const n = sorted.length;
    const percentile = (p: number): number => { const idx = Math.ceil((p / 100) * n) - 1; return sorted[Math.max(0, Math.min(idx, n - 1))]; };
    const avgMs = Number((sorted.reduce((a, b) => a + b, 0) / n).toFixed(2));
    const minMs = sorted[0];
    const maxMs = sorted[n - 1];
    const range = maxMs - minMs;
    const bucketSize = range > 0 ? Math.max(Math.ceil(range / 10), 1) : 1;

    const histMap = new Map<number, number>();
    for (const s of sorted) { const bucket = Math.floor(s / bucketSize) * bucketSize; histMap.set(bucket, (histMap.get(bucket) ?? 0) + 1); }
    const histogram = Array.from(histMap.entries()).sort(([a], [b]) => a - b).map(([bucket, count]) => ({ bucketMs: `${bucket}-${bucket + bucketSize}`, count }));

    return { asOf: now, totalSamples: n, p50Ms: percentile(50), p95Ms: percentile(95), p99Ms: percentile(99), avgMs, minMs, maxMs, histogram };
  }
}
