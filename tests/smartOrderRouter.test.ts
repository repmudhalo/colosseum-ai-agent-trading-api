import { describe, expect, it, beforeEach } from 'vitest';
import {
  SmartOrderRouterService,
  OrderRoute,
  TwapOrder,
  VwapOrder,
  IcebergOrder,
  ExecutionQualityScore,
  SlippageEstimate,
} from '../src/services/smartOrderRouterService.js';
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

describe('SmartOrderRouterService', () => {
  let service: SmartOrderRouterService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BONK'] = 0.002;
    const store = createMockStore(state);
    service = new SmartOrderRouterService(store);
  });

  // ─── Multi-Venue Order Routing ──────────────────────────────────────

  describe('routeOrder', () => {
    it('routes a buy order across multiple venues', () => {
      const route = service.routeOrder({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 10_000,
      });

      expect(route).toBeDefined();
      expect(route.routeId).toMatch(/^route-/);
      expect(route.symbol).toBe('SOL');
      expect(route.side).toBe('buy');
      expect(route.totalNotionalUsd).toBe(10_000);
      expect(route.legs.length).toBeGreaterThanOrEqual(1);
      expect(route.estimatedAvgPrice).toBeGreaterThan(0);
      expect(route.estimatedTotalFeeUsd).toBeGreaterThanOrEqual(0);
      expect(route.createdAt).toBeDefined();
    });

    it('splits large orders across multiple venues', () => {
      const route = service.routeOrder({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 5_000_000,
      });

      // With 3 SOL venues, large order should use multiple legs
      expect(route.legs.length).toBeGreaterThan(1);
      // Total allocation should sum to approximately the full order
      const totalAllocated = route.legs.reduce((s, l) => s + l.notionalUsd, 0);
      expect(totalAllocated).toBeGreaterThan(0);
      expect(totalAllocated).toBeLessThanOrEqual(route.totalNotionalUsd * 1.01);
    });

    it('falls back to single-venue route for unknown symbols', () => {
      const route = service.routeOrder({
        symbol: 'UNKNOWN',
        side: 'sell',
        notionalUsd: 1_000,
      });

      expect(route.legs.length).toBe(1);
      expect(route.legs[0].venueId).toBe('default');
      expect(route.legs[0].venueName).toBe('Default Pool');
    });

    it('respects maxSlippagePct parameter', () => {
      const route = service.routeOrder({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 1_000,
        maxSlippagePct: 0.001,  // very tight slippage tolerance
      });

      // Should still produce a route (even if fallback)
      expect(route).toBeDefined();
      expect(route.routeId).toBeDefined();
    });

    it('calculates expected savings vs worst venue', () => {
      const route = service.routeOrder({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 50_000,
      });

      expect(route.expectedSavingsUsd).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── TWAP Execution Engine ──────────────────────────────────────────

  describe('startTwap', () => {
    it('creates a TWAP order with correct slice count', () => {
      const order = service.startTwap({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 10_000,
        durationMs: 600_000,     // 10 minutes
        intervalMs: 60_000,      // 1 minute slices
      });

      expect(order.orderId).toMatch(/^twap-/);
      expect(order.symbol).toBe('SOL');
      expect(order.side).toBe('buy');
      expect(order.totalNotionalUsd).toBe(10_000);
      expect(order.slicesTotal).toBe(10);
      expect(order.slices.length).toBe(10);
      expect(order.status).toBe('completed');
      expect(order.avgExecutedPrice).toBeGreaterThan(0);
    });

    it('distributes notional evenly across slices', () => {
      const order = service.startTwap({
        symbol: 'SOL',
        side: 'sell',
        notionalUsd: 5_000,
        durationMs: 300_000,
        intervalMs: 60_000,
      });

      expect(order.slicesTotal).toBe(5);
      const totalSliceNotional = order.slices.reduce((s, sl) => s + sl.notionalUsd, 0);
      expect(totalSliceNotional).toBeCloseTo(5_000, 0);
      // Each slice should be approximately equal
      for (const slice of order.slices) {
        expect(slice.notionalUsd).toBeCloseTo(1_000, 1);
      }
    });

    it('can retrieve a TWAP order by ID', () => {
      const order = service.startTwap({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 2_000,
        durationMs: 120_000,
      });

      const retrieved = service.getTwapOrder(order.orderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.orderId).toBe(order.orderId);
    });

    it('returns null for non-existent TWAP order', () => {
      expect(service.getTwapOrder('nonexistent')).toBeNull();
    });
  });

  // ─── VWAP Execution Engine ──────────────────────────────────────────

  describe('startVwap', () => {
    it('creates a VWAP order with volume-weighted buckets', () => {
      const order = service.startVwap({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 20_000,
        durationMs: 600_000,
        buckets: 5,
      });

      expect(order.orderId).toMatch(/^vwap-/);
      expect(order.symbol).toBe('SOL');
      expect(order.bucketsTotal).toBe(5);
      expect(order.buckets.length).toBe(5);
      expect(order.status).toBe('completed');
      expect(order.vwapPrice).toBeGreaterThan(0);
      expect(order.avgExecutedPrice).toBeGreaterThan(0);

      // Volume weights should sum to approximately 1
      const totalWeight = order.buckets.reduce((s, b) => s + b.volumeWeight, 0);
      expect(totalWeight).toBeCloseTo(1, 1);
    });

    it('bucket notionals sum to total order size', () => {
      const order = service.startVwap({
        symbol: 'BONK',
        side: 'sell',
        notionalUsd: 10_000,
        durationMs: 300_000,
        buckets: 8,
      });

      const totalBucketNotional = order.buckets.reduce((s, b) => s + b.notionalUsd, 0);
      expect(totalBucketNotional).toBeCloseTo(10_000, 0);
    });

    it('can retrieve a VWAP order by ID', () => {
      const order = service.startVwap({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 5_000,
        durationMs: 120_000,
      });

      const retrieved = service.getVwapOrder(order.orderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.orderId).toBe(order.orderId);
    });
  });

  // ─── Iceberg Orders ─────────────────────────────────────────────────

  describe('startIceberg', () => {
    it('creates an iceberg order with hidden chunks', () => {
      const order = service.startIceberg({
        symbol: 'SOL',
        side: 'buy',
        totalNotionalUsd: 100_000,
        visiblePct: 0.1,
      });

      expect(order.orderId).toMatch(/^iceberg-/);
      expect(order.symbol).toBe('SOL');
      expect(order.totalNotionalUsd).toBe(100_000);
      expect(order.visibleNotionalUsd).toBe(10_000);
      expect(order.chunksTotal).toBe(10);
      expect(order.chunks.length).toBe(10);
      expect(order.status).toBe('completed');
      expect(order.avgExecutedPrice).toBeGreaterThan(0);
    });

    it('respects custom chunk size', () => {
      const order = service.startIceberg({
        symbol: 'SOL',
        side: 'sell',
        totalNotionalUsd: 50_000,
        chunkSize: 5_000,
      });

      expect(order.chunkSize).toBe(5_000);
      expect(order.chunksTotal).toBe(10);
      // Each chunk should be approximately 5000
      for (const chunk of order.chunks) {
        expect(chunk.notionalUsd).toBeLessThanOrEqual(5_000);
        expect(chunk.notionalUsd).toBeGreaterThan(0);
      }
    });

    it('chunk notionals sum to total order size', () => {
      const order = service.startIceberg({
        symbol: 'BONK',
        side: 'buy',
        totalNotionalUsd: 25_000,
      });

      const totalChunkNotional = order.chunks.reduce((s, c) => s + c.notionalUsd, 0);
      expect(totalChunkNotional).toBeCloseTo(25_000, 0);
    });

    it('can retrieve an iceberg order by ID', () => {
      const order = service.startIceberg({
        symbol: 'SOL',
        side: 'buy',
        totalNotionalUsd: 10_000,
      });

      const retrieved = service.getIcebergOrder(order.orderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.orderId).toBe(order.orderId);
    });
  });

  // ─── Execution Quality Scoring ──────────────────────────────────────

  describe('scoreExecution', () => {
    it('returns null for non-existent intent', () => {
      const score = service.scoreExecution('nonexistent-intent');
      expect(score).toBeNull();
    });

    it('scores execution quality for an existing intent', () => {
      // Insert a mock intent into state
      state.tradeIntents['intent-1'] = {
        id: 'intent-1',
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 1000,
        status: 'executed',
        createdAt: new Date().toISOString(),
      } as any;

      const store = createMockStore(state);
      const svc = new SmartOrderRouterService(store);

      const score = svc.scoreExecution('intent-1');
      expect(score).not.toBeNull();
      expect(score!.intentId).toBe('intent-1');
      expect(score!.benchmarkPrice).toBeGreaterThan(0);
      expect(score!.executedPrice).toBeGreaterThan(0);
      expect(score!.slippageBps).toBeGreaterThanOrEqual(0);
      expect(score!.totalCostBps).toBeGreaterThanOrEqual(0);
      expect(['excellent', 'good', 'fair', 'poor']).toContain(score!.qualityRating);
      expect(score!.score).toBeGreaterThanOrEqual(0);
      expect(score!.score).toBeLessThanOrEqual(100);
    });

    it('caches execution quality scores', () => {
      state.tradeIntents['intent-2'] = {
        id: 'intent-2',
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'sell',
        notionalUsd: 500,
        status: 'executed',
        createdAt: new Date().toISOString(),
      } as any;

      const store = createMockStore(state);
      const svc = new SmartOrderRouterService(store);

      const score1 = svc.scoreExecution('intent-2');
      const score2 = svc.scoreExecution('intent-2');
      expect(score1!.intentId).toBe(score2!.intentId);
      expect(score1!.timestamp).toBe(score2!.timestamp);
    });
  });

  // ─── Slippage Prediction Model ──────────────────────────────────────

  describe('predictSlippage', () => {
    it('estimates slippage for a given order', () => {
      const estimate = service.predictSlippage({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 10_000,
      });

      expect(estimate.symbol).toBe('SOL');
      expect(estimate.side).toBe('buy');
      expect(estimate.notionalUsd).toBe(10_000);
      expect(estimate.estimatedSlippageBps).toBeGreaterThanOrEqual(0);
      expect(estimate.estimatedSlippagePct).toBeGreaterThanOrEqual(0);
      expect(estimate.estimatedSlippageUsd).toBeGreaterThanOrEqual(0);
      expect(estimate.confidence).toBeGreaterThan(0);
      expect(estimate.confidence).toBeLessThanOrEqual(1);
      expect(estimate.model).toBe('linear-v1');
      expect(estimate.factors.length).toBeGreaterThanOrEqual(3);
    });

    it('predicts higher slippage for larger orders', () => {
      const small = service.predictSlippage({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 1_000,
      });

      const large = service.predictSlippage({
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 1_000_000,
      });

      expect(large.estimatedSlippageBps).toBeGreaterThan(small.estimatedSlippageBps);
    });

    it('returns factors explaining slippage breakdown', () => {
      const estimate = service.predictSlippage({
        symbol: 'BONK',
        side: 'sell',
        notionalUsd: 5_000,
      });

      const factorNames = estimate.factors.map((f) => f.name);
      expect(factorNames).toContain('order_size_impact');
      expect(factorNames).toContain('spread_cost');
      expect(factorNames).toContain('historical_slippage');
      expect(factorNames).toContain('venue_fragmentation');

      // Weights should sum to 1
      const totalWeight = estimate.factors.reduce((s, f) => s + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 2);
    });
  });
});
