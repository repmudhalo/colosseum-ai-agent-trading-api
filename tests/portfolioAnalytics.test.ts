import { describe, expect, it, vi } from 'vitest';
import { PortfolioAnalyticsService } from '../src/services/portfolioAnalyticsService.js';
import { AppState, Agent, ExecutionRecord } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return { snapshot: () => structuredClone(state), transaction: vi.fn(), init: vi.fn(), flush: vi.fn() } as any;
}

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent-${id}`,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000,
    cashUsd: 10_000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10_000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {},
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
    ...overrides,
  };
}

function makeExecution(id: string, agentId: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id,
    intentId: `intent-${id}`,
    agentId,
    symbol: 'SOL',
    side: 'buy',
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 1,
    netUsd: 999,
    realizedPnlUsd: 0,
    pnlSnapshotUsd: 0,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function setup(opts: {
  agents?: Agent[];
  executions?: ExecutionRecord[];
  solPriceHistory?: Array<{ ts: string; priceUsd: number }>;
} = {}) {
  const state = createDefaultState();
  for (const a of opts.agents ?? [makeAgent('a1')]) {
    state.agents[a.id] = a;
  }
  for (const ex of opts.executions ?? []) {
    state.executions[ex.id] = ex;
  }
  if (opts.solPriceHistory) {
    state.marketPriceHistoryUsd['SOL'] = opts.solPriceHistory;
  }
  return new PortfolioAnalyticsService(createMockStore(state));
}

// ─── Helpers for generating multi-day data ────────────────────────

function makeDate(dayOffset: number): string {
  const d = new Date('2025-01-01');
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString().slice(0, 10) + 'T12:00:00Z';
}

function generateDailyExecutions(agentId: string, pnls: number[], symbol = 'SOL'): ExecutionRecord[] {
  return pnls.map((pnl, i) =>
    makeExecution(`ex-${symbol}-${i}`, agentId, {
      symbol,
      createdAt: makeDate(i),
      realizedPnlUsd: pnl,
      side: 'sell',
    }),
  );
}

function generateSolPriceHistory(prices: number[]): Array<{ ts: string; priceUsd: number }> {
  return prices.map((priceUsd, i) => ({
    ts: makeDate(i),
    priceUsd,
  }));
}

// ─── Tests ────────────────────────────────────────────────────────

describe('PortfolioAnalyticsService', () => {

  // ── VaR + CVaR ────────────────────────────────────────────────

  describe('computeVaR', () => {
    it('returns null for agent with < 2 observations', () => {
      const service = setup({ executions: [makeExecution('e1', 'a1', { createdAt: makeDate(0), realizedPnlUsd: 50 })] });
      const result = service.computeVaR('a1');
      expect(result.historicalVaR).toBeNull();
      expect(result.parametricVaR).toBeNull();
      expect(result.cvar).toBeNull();
      expect(result.observationCount).toBe(1);
    });

    it('computes VaR and CVaR for multi-day data', () => {
      const pnls = [100, -50, 30, -80, 60, -20, 40, -70, 10, -30];
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const result = service.computeVaR('a1', 0.95);

      expect(result.agentId).toBe('a1');
      expect(result.confidenceLevel).toBe(0.95);
      expect(result.observationCount).toBe(10);
      expect(result.historicalVaR).toBeTypeOf('number');
      expect(result.parametricVaR).toBeTypeOf('number');
      expect(result.cvar).toBeTypeOf('number');
    });

    it('historical VaR increases with higher confidence', () => {
      const pnls = [100, -50, 30, -80, 60, -20, 40, -70, 10, -30, 50, -90, 20, -60, 80];
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const var90 = service.computeVaR('a1', 0.9);
      const var99 = service.computeVaR('a1', 0.99);
      // Higher confidence → larger VaR (more conservative)
      expect(var99.historicalVaR!).toBeGreaterThanOrEqual(var90.historicalVaR!);
    });

    it('CVaR is at least as large as historical VaR', () => {
      const pnls = [100, -50, 30, -80, 60, -20, 40, -70, 10, -30, 50, -90, 20];
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const result = service.computeVaR('a1', 0.95);
      expect(result.cvar!).toBeGreaterThanOrEqual(result.historicalVaR!);
    });

    it('throws for unknown agent', () => {
      const service = setup();
      expect(() => service.computeVaR('ghost')).toThrow();
    });
  });

  // ── Greeks ────────────────────────────────────────────────────

  describe('computeGreeks', () => {
    it('returns null for agent with < 3 observations', () => {
      const service = setup({
        executions: [
          makeExecution('e1', 'a1', { createdAt: makeDate(0), realizedPnlUsd: 50 }),
          makeExecution('e2', 'a1', { createdAt: makeDate(1), realizedPnlUsd: -20 }),
        ],
      });
      const result = service.computeGreeks('a1');
      expect(result.beta).toBeNull();
      expect(result.alpha).toBeNull();
      expect(result.informationRatio).toBeNull();
    });

    it('computes beta, alpha, IR for multi-day agent', () => {
      const pnls = [100, -50, 30, -80, 60, -20, 40, -70, 10, -30];
      const solPrices = generateSolPriceHistory([100, 102, 99, 101, 97, 103, 100, 98, 104, 101]);
      const service = setup({
        executions: generateDailyExecutions('a1', pnls),
        solPriceHistory: solPrices,
      });
      const result = service.computeGreeks('a1');
      expect(result.benchmark).toBe('SOL');
      expect(result.beta).toBeTypeOf('number');
      expect(result.alpha).toBeTypeOf('number');
      expect(result.informationRatio).toBeTypeOf('number');
      expect(result.observationCount).toBeGreaterThan(0);
    });

    it('throws for unknown agent', () => {
      const service = setup();
      expect(() => service.computeGreeks('ghost')).toThrow();
    });
  });

  // ── Correlation ───────────────────────────────────────────────

  describe('computeCorrelation', () => {
    it('returns identity-like matrix for single asset', () => {
      const execs = generateDailyExecutions('a1', [10, -5, 20], 'SOL');
      const service = setup({ executions: execs });
      const result = service.computeCorrelation('a1');
      expect(result.assets).toEqual(['SOL']);
      // 1x1 matrix: self-correlation = 1
      expect(result.matrix[0][0]).toBe(1);
    });

    it('returns correct dimensions for multi-asset portfolio', () => {
      const solExecs = generateDailyExecutions('a1', [10, -5, 20, 15], 'SOL');
      const btcExecs = [
        makeExecution('ex-BTC-0', 'a1', { symbol: 'BTC', createdAt: makeDate(0), realizedPnlUsd: 20, side: 'sell' }),
        makeExecution('ex-BTC-1', 'a1', { symbol: 'BTC', createdAt: makeDate(1), realizedPnlUsd: -10, side: 'sell' }),
        makeExecution('ex-BTC-2', 'a1', { symbol: 'BTC', createdAt: makeDate(2), realizedPnlUsd: 30, side: 'sell' }),
        makeExecution('ex-BTC-3', 'a1', { symbol: 'BTC', createdAt: makeDate(3), realizedPnlUsd: -5, side: 'sell' }),
      ];
      const service = setup({ executions: [...solExecs, ...btcExecs] });
      const result = service.computeCorrelation('a1');
      expect(result.assets).toContain('SOL');
      expect(result.assets).toContain('BTC');
      expect(result.matrix.length).toBe(2);
      expect(result.matrix[0].length).toBe(2);
      // Diagonal should be 1
      expect(result.matrix[0][0]).toBe(1);
      expect(result.matrix[1][1]).toBe(1);
    });

    it('correlation values are between -1 and 1', () => {
      const solExecs = generateDailyExecutions('a1', [10, -5, 20, -15, 30], 'SOL');
      const btcExecs = [
        makeExecution('ex-BTC-0', 'a1', { symbol: 'BTC', createdAt: makeDate(0), realizedPnlUsd: -10, side: 'sell' }),
        makeExecution('ex-BTC-1', 'a1', { symbol: 'BTC', createdAt: makeDate(1), realizedPnlUsd: 5, side: 'sell' }),
        makeExecution('ex-BTC-2', 'a1', { symbol: 'BTC', createdAt: makeDate(2), realizedPnlUsd: -20, side: 'sell' }),
        makeExecution('ex-BTC-3', 'a1', { symbol: 'BTC', createdAt: makeDate(3), realizedPnlUsd: 15, side: 'sell' }),
        makeExecution('ex-BTC-4', 'a1', { symbol: 'BTC', createdAt: makeDate(4), realizedPnlUsd: -30, side: 'sell' }),
      ];
      const service = setup({ executions: [...solExecs, ...btcExecs] });
      const result = service.computeCorrelation('a1');
      for (const row of result.matrix) {
        for (const val of row) {
          expect(val).toBeGreaterThanOrEqual(-1);
          expect(val).toBeLessThanOrEqual(1);
        }
      }
    });

    it('returns empty matrix for agent with no trades', () => {
      const service = setup();
      const result = service.computeCorrelation('a1');
      expect(result.assets).toEqual([]);
      expect(result.matrix).toEqual([]);
    });
  });

  // ── Attribution ───────────────────────────────────────────────

  describe('computeAttribution', () => {
    it('returns empty entries for agent with no executions', () => {
      const service = setup();
      const result = service.computeAttribution('a1');
      expect(result.entries).toEqual([]);
      expect(result.totalPnlUsd).toBe(0);
    });

    it('computes per-asset contribution', () => {
      const execs = [
        makeExecution('e1', 'a1', { symbol: 'SOL', realizedPnlUsd: 80, side: 'sell' }),
        makeExecution('e2', 'a1', { symbol: 'BTC', realizedPnlUsd: 20, side: 'sell' }),
      ];
      const service = setup({ executions: execs });
      const result = service.computeAttribution('a1');
      expect(result.totalPnlUsd).toBeCloseTo(100, 4);
      expect(result.entries.length).toBe(2);
      // SOL contributed 80% of total
      const solEntry = result.entries.find((e) => e.symbol === 'SOL')!;
      expect(solEntry.contributionPct).toBeCloseTo(80, 4);
    });

    it('handles negative PnL attribution', () => {
      const execs = [
        makeExecution('e1', 'a1', { symbol: 'SOL', realizedPnlUsd: -60, side: 'sell' }),
        makeExecution('e2', 'a1', { symbol: 'BTC', realizedPnlUsd: -40, side: 'sell' }),
      ];
      const service = setup({ executions: execs });
      const result = service.computeAttribution('a1');
      expect(result.totalPnlUsd).toBeCloseTo(-100, 4);
      // Entries should sum contribution percentages sensibly
      const total = result.entries.reduce((s, e) => s + e.contributionPct, 0);
      expect(total).toBeCloseTo(-100, 2);
    });

    it('sorts entries by absolute PnL descending', () => {
      const execs = [
        makeExecution('e1', 'a1', { symbol: 'SOL', realizedPnlUsd: 10, side: 'sell' }),
        makeExecution('e2', 'a1', { symbol: 'BTC', realizedPnlUsd: -50, side: 'sell' }),
        makeExecution('e3', 'a1', { symbol: 'JUP', realizedPnlUsd: 30, side: 'sell' }),
      ];
      const service = setup({ executions: execs });
      const result = service.computeAttribution('a1');
      expect(result.entries[0].symbol).toBe('BTC');
      expect(result.entries[1].symbol).toBe('JUP');
      expect(result.entries[2].symbol).toBe('SOL');
    });

    it('throws for unknown agent', () => {
      const service = setup();
      expect(() => service.computeAttribution('ghost')).toThrow();
    });
  });

  // ── Rolling Sharpe ────────────────────────────────────────────

  describe('computeRollingSharpe', () => {
    it('returns empty points when fewer days than window', () => {
      const pnls = [10, -5, 20];
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const result = service.computeRollingSharpe('a1', 30);
      expect(result.points).toEqual([]);
      expect(result.windowDays).toBe(30);
    });

    it('returns correct number of points for larger dataset', () => {
      const pnls = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 50 : -30));
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const result = service.computeRollingSharpe('a1', 10);
      // With 40 data points and window=10, should get 31 points
      expect(result.points.length).toBe(31);
    });

    it('sharpe values are numbers or null when stddev is 0', () => {
      // All positive constant → stddev = 0 → null
      const pnls = Array.from({ length: 10 }, () => 50);
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const result = service.computeRollingSharpe('a1', 5);
      // Constant returns → std = 0 → null
      for (const point of result.points) {
        expect(point.sharpe).toBeNull();
      }
    });

    it('uses configurable window size', () => {
      const pnls = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? 100 : -40));
      const service = setup({ executions: generateDailyExecutions('a1', pnls) });
      const r5 = service.computeRollingSharpe('a1', 5);
      const r10 = service.computeRollingSharpe('a1', 10);
      expect(r5.windowDays).toBe(5);
      expect(r10.windowDays).toBe(10);
      expect(r5.points.length).toBeGreaterThan(r10.points.length);
    });

    it('throws for unknown agent', () => {
      const service = setup();
      expect(() => service.computeRollingSharpe('ghost')).toThrow();
    });
  });
});
