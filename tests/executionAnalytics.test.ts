import { describe, expect, it, vi } from 'vitest';
import { ExecutionAnalyticsService } from '../src/services/executionAnalyticsService.js';
import { AppState, Agent, ExecutionRecord } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return { snapshot: () => structuredClone(state), transaction: vi.fn(), init: vi.fn(), flush: vi.fn() } as any;
}

function makeAgent(id: string, name: string): Agent {
  return {
    id, name, apiKey: `key-${id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000, cashUsd: 10_000, realizedPnlUsd: 0, peakEquityUsd: 10_000,
    riskLimits: { maxPositionSizePct: 0.25, maxOrderNotionalUsd: 2500, maxGrossExposureUsd: 7500, dailyLossCapUsd: 1000, maxDrawdownPct: 0.2, cooldownSeconds: 3 },
    positions: {}, dailyRealizedPnlUsd: {}, riskRejectionsByReason: {}, strategyId: 'momentum-v1',
  };
}

function makeExecution(id: string, agentId: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id, intentId: `intent-${id}`, agentId, symbol: 'SOL', side: 'buy', quantity: 10, priceUsd: 100,
    grossNotionalUsd: 1000, feeUsd: 1, netUsd: 999, realizedPnlUsd: 0, pnlSnapshotUsd: 0,
    mode: 'paper', status: 'filled', createdAt: new Date().toISOString(), ...overrides,
  };
}

describe('ExecutionAnalyticsService', () => {
  function setup(agentCount = 2, executions: ExecutionRecord[] = []) {
    const state = createDefaultState();
    for (let i = 1; i <= agentCount; i++) state.agents[`agent-${i}`] = makeAgent(`agent-${i}`, `Agent ${i}`);
    for (const ex of executions) state.executions[ex.id] = ex;
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BTC'] = 50000;
    return { state, service: new ExecutionAnalyticsService(createMockStore(state)) };
  }

  describe('getExecutionTimeline', () => {
    it('returns empty timeline for agent with no executions', () => {
      const { service } = setup();
      const t = service.getExecutionTimeline('agent-1');
      expect(t.agentId).toBe('agent-1');
      expect(t.points).toEqual([]);
      expect(t.totalExecutions).toBe(0);
      expect(t.firstExecution).toBeNull();
    });

    it('returns chronological timeline with cumulative PnL', () => {
      const executions = [
        makeExecution('ex-1', 'agent-1', { createdAt: '2025-01-01T10:00:00Z', realizedPnlUsd: 50 }),
        makeExecution('ex-2', 'agent-1', { createdAt: '2025-01-01T11:00:00Z', realizedPnlUsd: -20 }),
        makeExecution('ex-3', 'agent-1', { createdAt: '2025-01-01T12:00:00Z', realizedPnlUsd: 30 }),
      ];
      const { service } = setup(2, executions);
      const t = service.getExecutionTimeline('agent-1');
      expect(t.totalExecutions).toBe(3);
      expect(t.points[0].cumulativePnlUsd).toBe(50);
      expect(t.points[1].cumulativePnlUsd).toBe(30);
      expect(t.points[2].cumulativePnlUsd).toBe(60);
    });

    it('excludes failed executions', () => {
      const { service } = setup(2, [makeExecution('ex-1', 'agent-1'), makeExecution('ex-2', 'agent-1', { status: 'failed' })]);
      expect(service.getExecutionTimeline('agent-1').totalExecutions).toBe(1);
    });

    it('throws for unknown agent', () => { const { service } = setup(); expect(() => service.getExecutionTimeline('ghost')).toThrow('Agent not found'); });
  });

  describe('getSlippageAnalysis', () => {
    it('returns empty analysis for agent with no executions', () => {
      const { service } = setup();
      const a = service.getSlippageAnalysis('agent-1');
      expect(a.entries).toEqual([]);
      expect(a.avgSlippagePct).toBe(0);
    });

    it('computes slippage for buy orders', () => {
      const { service } = setup(2, [makeExecution('ex-1', 'agent-1', { symbol: 'SOL', side: 'buy', priceUsd: 101 })]);
      const a = service.getSlippageAnalysis('agent-1');
      expect(a.entries[0].expectedPriceUsd).toBe(100);
      expect(a.entries[0].actualPriceUsd).toBe(101);
      expect(a.entries[0].slippageUsd).toBe(1);
    });

    it('counts positive/negative/zero slippage', () => {
      const { service } = setup(2, [
        makeExecution('ex-1', 'agent-1', { priceUsd: 100 }),
        makeExecution('ex-2', 'agent-1', { priceUsd: 105 }),
        makeExecution('ex-3', 'agent-1', { priceUsd: 95 }),
      ]);
      const a = service.getSlippageAnalysis('agent-1');
      expect(a.positiveSlippageCount).toBe(1);
      expect(a.negativeSlippageCount).toBe(1);
      expect(a.zeroSlippageCount).toBe(1);
    });

    it('throws for unknown agent', () => { const { service } = setup(); expect(() => service.getSlippageAnalysis('ghost')).toThrow('Agent not found'); });
  });

  describe('getVolumeProfile', () => {
    it('returns empty profile for symbol with no executions', () => {
      const { service } = setup();
      const p = service.getVolumeProfile('ETH');
      expect(p.levels).toEqual([]);
      expect(p.totalVolume).toBe(0);
    });

    it('computes volume levels', () => {
      const { service } = setup(2, [
        makeExecution('ex-1', 'agent-1', { symbol: 'SOL', side: 'buy', priceUsd: 100, grossNotionalUsd: 1000 }),
        makeExecution('ex-2', 'agent-1', { symbol: 'SOL', side: 'sell', priceUsd: 100, grossNotionalUsd: 500 }),
        makeExecution('ex-3', 'agent-1', { symbol: 'SOL', side: 'buy', priceUsd: 105, grossNotionalUsd: 2000 }),
      ]);
      const p = service.getVolumeProfile('SOL');
      expect(p.levels.length).toBeGreaterThan(0);
      expect(p.totalVolume).toBe(3500);
    });

    it('normalizes symbol to uppercase', () => {
      const { service } = setup(2, [makeExecution('ex-1', 'agent-1', { symbol: 'SOL', grossNotionalUsd: 1000 })]);
      expect(service.getVolumeProfile('sol').symbol).toBe('SOL');
    });
  });

  describe('getExecutionQuality', () => {
    it('returns quality metrics', () => {
      const { service } = setup(2, [
        makeExecution('ex-1', 'agent-1', { status: 'filled', feeUsd: 2, grossNotionalUsd: 1000 }),
        makeExecution('ex-2', 'agent-1', { status: 'filled', feeUsd: 3, grossNotionalUsd: 2000 }),
        makeExecution('ex-3', 'agent-1', { status: 'failed' }),
      ]);
      const q = service.getExecutionQuality('agent-1');
      expect(q.totalExecutions).toBe(3);
      expect(q.filledCount).toBe(2);
      expect(q.failedCount).toBe(1);
      expect(q.fillRate).toBeCloseTo(0.6667, 3);
      expect(q.totalFeesUsd).toBe(5);
    });

    it('computes VWAP comparison', () => {
      const { service } = setup(2, [makeExecution('ex-1', 'agent-1', { symbol: 'SOL', priceUsd: 99, quantity: 10 })]);
      const q = service.getExecutionQuality('agent-1');
      expect(q.vwapComparison).not.toBeNull();
      expect(q.vwapComparison!.agentVwap).toBe(99);
      expect(q.vwapComparison!.outperformancePct).toBeGreaterThan(0);
    });

    it('returns symbol breakdown', () => {
      const { service } = setup(2, [
        makeExecution('ex-1', 'agent-1', { symbol: 'SOL' }),
        makeExecution('ex-2', 'agent-1', { symbol: 'BTC', priceUsd: 50000, grossNotionalUsd: 50000 }),
      ]);
      expect(service.getExecutionQuality('agent-1').symbolBreakdown).toHaveLength(2);
    });

    it('returns empty for no executions', () => {
      const { service } = setup();
      const q = service.getExecutionQuality('agent-1');
      expect(q.totalExecutions).toBe(0);
      expect(q.vwapComparison).toBeNull();
    });

    it('throws for unknown agent', () => { const { service } = setup(); expect(() => service.getExecutionQuality('ghost')).toThrow('Agent not found'); });
  });

  describe('getLatencyMetrics', () => {
    it('returns zeros when no samples', () => {
      const { service } = setup();
      const m = service.getLatencyMetrics();
      expect(m.totalSamples).toBe(0);
      expect(m.p50Ms).toBe(0);
      expect(m.histogram).toEqual([]);
    });

    it('computes percentiles correctly', () => {
      const { service } = setup();
      for (let i = 1; i <= 100; i++) service.recordLatency(i);
      const m = service.getLatencyMetrics();
      expect(m.totalSamples).toBe(100);
      expect(m.p50Ms).toBe(50);
      expect(m.p95Ms).toBe(95);
      expect(m.p99Ms).toBe(99);
      expect(m.avgMs).toBeCloseTo(50.5, 1);
    });

    it('builds histogram', () => {
      const { service } = setup();
      for (let i = 0; i < 50; i++) { service.recordLatency(10); service.recordLatency(50); }
      expect(service.getLatencyMetrics().histogram.length).toBeGreaterThan(0);
    });

    it('handles single sample', () => {
      const { service } = setup();
      service.recordLatency(42);
      const m = service.getLatencyMetrics();
      expect(m.p50Ms).toBe(42);
      expect(m.p99Ms).toBe(42);
    });
  });
});
