import { describe, expect, it, vi } from 'vitest';
import { DefiHealthScoreService } from '../src/services/defiHealthScoreService.js';
import { AppState, Agent, ExecutionRecord, Position } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name,
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

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    intentId: 'intent-1',
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'sell',
    quantity: 1,
    priceUsd: 110,
    grossNotionalUsd: 110,
    feeUsd: 0.088,
    netUsd: 109.912,
    realizedPnlUsd: 10,
    pnlSnapshotUsd: 10,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DefiHealthScoreService', () => {
  // ── 1. Unknown agent ───────────────────────────────────────────────
  it('returns null for unknown agent', () => {
    const state = createDefaultState();
    const service = new DefiHealthScoreService(createMockStore(state));
    expect(service.calculateHealthScore('nonexistent')).toBeNull();
  });

  // ── 2. Agent with no trades ────────────────────────────────────────
  it('computes a health score for an agent with no trades', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Empty Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const result = service.calculateHealthScore('agent-1');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-1');
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(100);
    expect(result!.grade).toBeDefined();
    expect(result!.factors.length).toBe(5);
    expect(result!.recommendations).toBeDefined();
  });

  // ── 3. Score stays within 0-100 ───────────────────────────────────
  it('score stays within 0-100 bounds', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Bounded');
    const service = new DefiHealthScoreService(createMockStore(state));

    const rating = service.calculateHealthScore('agent-1');
    expect(rating).not.toBeNull();
    expect(rating!.score).toBeGreaterThanOrEqual(0);
    expect(rating!.score).toBeLessThanOrEqual(100);
  });

  // ── 4. Factor weights sum to 1.0 ──────────────────────────────────
  it('factor weights sum to 1.0', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Weights Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const breakdown = service.calculateHealthScore('agent-1');
    expect(breakdown).not.toBeNull();
    const totalWeight = breakdown!.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  // ── 5. All five factor names present ──────────────────────────────
  it('includes all five health factors', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Factors Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const breakdown = service.calculateHealthScore('agent-1');
    const names = breakdown!.factors.map((f) => f.name);
    expect(names).toContain('diversification');
    expect(names).toContain('riskAdjustedReturns');
    expect(names).toContain('drawdownSeverity');
    expect(names).toContain('concentrationRisk');
    expect(names).toContain('consistency');
  });

  // ── 6. Correct letter grades ──────────────────────────────────────
  it('assigns correct letter grades based on score', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Grade Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const result = service.calculateHealthScore('agent-1');
    expect(result).not.toBeNull();
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result!.grade);

    if (result!.score >= 90) expect(result!.grade).toBe('A');
    else if (result!.score >= 80) expect(result!.grade).toBe('B');
    else if (result!.score >= 70) expect(result!.grade).toBe('C');
    else if (result!.score >= 60) expect(result!.grade).toBe('D');
    else expect(result!.grade).toBe('F');
  });

  // ── 7. High score for winning diversified agent ───────────────────
  it('assigns high score to diversified agent with winning trades', () => {
    const state = createDefaultState();
    const positions: Record<string, Position> = {
      SOL: { symbol: 'SOL', quantity: 10, avgEntryPriceUsd: 100 },
      BTC: { symbol: 'BTC', quantity: 0.1, avgEntryPriceUsd: 40000 },
      ETH: { symbol: 'ETH', quantity: 2, avgEntryPriceUsd: 2000 },
      BONK: { symbol: 'BONK', quantity: 1000000, avgEntryPriceUsd: 0.00001 },
      JTO: { symbol: 'JTO', quantity: 100, avgEntryPriceUsd: 3 },
    };

    state.agents['agent-1'] = makeAgent('agent-1', 'Diversified Winner', { positions });
    state.marketPricesUsd = {
      SOL: 110, BTC: 42000, ETH: 2200, BONK: 0.000012, JTO: 3.5,
    };

    // Add consistent winning sell trades
    for (let i = 0; i < 20; i++) {
      state.executions[`sell-${i}`] = makeExecution({
        id: `sell-${i}`,
        side: 'sell',
        realizedPnlUsd: 50 + Math.random() * 20,
        grossNotionalUsd: 500,
        createdAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
      });
    }

    const service = new DefiHealthScoreService(createMockStore(state));
    const result = service.calculateHealthScore('agent-1');

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(65);
    expect(result!.factors.find((f) => f.name === 'diversification')!.normalizedScore).toBe(100);
  });

  // ── 8. Penalizes heavy drawdown ───────────────────────────────────
  it('penalizes heavy drawdown', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Drawdown Agent');

    // Series of losing trades
    state.executions = {
      e1: makeExecution({ id: 'e1', side: 'sell', realizedPnlUsd: -3000, grossNotionalUsd: 3000, createdAt: '2026-01-01T10:00:00Z' }),
      e2: makeExecution({ id: 'e2', side: 'sell', realizedPnlUsd: -4000, grossNotionalUsd: 4000, createdAt: '2026-01-01T11:00:00Z' }),
    };

    const service = new DefiHealthScoreService(createMockStore(state));
    const result = service.calculateHealthScore('agent-1');

    expect(result).not.toBeNull();
    const drawdownFactor = result!.factors.find((f) => f.name === 'drawdownSeverity')!;
    // 7000 loss on 10000 capital = 70% drawdown → drawdown score ≈ 30
    expect(drawdownFactor.normalizedScore).toBeLessThan(40);
    expect(result!.score).toBeLessThan(50);
  });

  // ── 9. Penalizes concentrated portfolio ───────────────────────────
  it('penalizes concentrated single-asset portfolio', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Concentrated', {
      positions: {
        SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 },
      },
    });
    state.marketPricesUsd = { SOL: 100 };

    const service = new DefiHealthScoreService(createMockStore(state));
    const result = service.calculateHealthScore('agent-1');

    const concFactor = result!.factors.find((f) => f.name === 'concentrationRisk')!;
    // Single position → HHI = 1.0 → score ≈ 0
    expect(concFactor.normalizedScore).toBeLessThanOrEqual(5);

    const divFactor = result!.factors.find((f) => f.name === 'diversification')!;
    expect(divFactor.normalizedScore).toBe(20); // 1 asset → 20
  });

  // ── 10. Caching and getHealthScore ────────────────────────────────
  it('getHealthScore returns cached value after calculation', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Cached Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const fresh = service.calculateHealthScore('agent-1');
    const cached = service.getHealthScore('agent-1');

    expect(cached).not.toBeNull();
    expect(cached!.score).toBe(fresh!.score);
    expect(cached!.grade).toBe(fresh!.grade);
  });

  // ── 11. getHealthScore computes if not cached ─────────────────────
  it('getHealthScore computes fresh if no cache', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Fresh Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const result = service.getHealthScore('agent-1');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-1');
    expect(typeof result!.score).toBe('number');
  });

  // ── 12. getHealthScore returns null for unknown agent ─────────────
  it('getHealthScore returns null for unknown agent', () => {
    const state = createDefaultState();
    const service = new DefiHealthScoreService(createMockStore(state));
    expect(service.getHealthScore('ghost')).toBeNull();
  });

  // ── 13. History tracking ──────────────────────────────────────────
  it('records and returns health score history', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'History Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    // Initially empty
    expect(service.getHealthHistory('agent-1')).toEqual([]);

    // Calculate twice to generate 2 snapshots
    service.calculateHealthScore('agent-1');
    service.calculateHealthScore('agent-1');

    const history = service.getHealthHistory('agent-1');
    expect(history.length).toBe(2);
    expect(history[0]).toHaveProperty('score');
    expect(history[0]).toHaveProperty('grade');
    expect(history[0]).toHaveProperty('timestamp');
  });

  // ── 14. History limit ─────────────────────────────────────────────
  it('respects history limit parameter', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Limit Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    for (let i = 0; i < 5; i++) {
      service.calculateHealthScore('agent-1');
    }

    const limited = service.getHealthHistory('agent-1', 3);
    expect(limited.length).toBe(3);
  });

  // ── 15. Recommendations generated ─────────────────────────────────
  it('generates recommendations based on weak factors', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Weak Agent', {
      positions: {
        SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 },
      },
    });
    state.marketPricesUsd = { SOL: 100 };

    // Add losing trades
    for (let i = 0; i < 10; i++) {
      state.executions[`sell-${i}`] = makeExecution({
        id: `sell-${i}`,
        side: 'sell',
        realizedPnlUsd: -200,
        grossNotionalUsd: 1000,
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
      });
    }

    const service = new DefiHealthScoreService(createMockStore(state));
    const result = service.calculateHealthScore('agent-1');

    expect(result!.recommendations.length).toBeGreaterThan(0);
    // Should recommend diversification since only 1 asset
    expect(result!.recommendations.some((r) => r.toLowerCase().includes('diversif'))).toBe(true);
  });

  // ── 16. getHealthScoreBreakdown returns detailed factors ──────────
  it('getHealthScoreBreakdown returns factor details', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Breakdown Agent');
    const service = new DefiHealthScoreService(createMockStore(state));

    const breakdown = service.getHealthScoreBreakdown('agent-1');
    expect(breakdown).not.toBeNull();
    expect(breakdown!.factors.length).toBe(5);
    expect(breakdown!.factors.every((f) => typeof f.weightedScore === 'number')).toBe(true);
    expect(breakdown!.factors.every((f) => typeof f.description === 'string')).toBe(true);
  });

  // ── 17. Failed executions are ignored ─────────────────────────────
  it('ignores failed executions in calculations', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Filter Agent');

    state.executions = {
      e1: makeExecution({ id: 'e1', status: 'failed', realizedPnlUsd: -5000 }),
      e2: makeExecution({ id: 'e2', status: 'filled', side: 'sell', realizedPnlUsd: 100, grossNotionalUsd: 1000 }),
    };

    const service = new DefiHealthScoreService(createMockStore(state));
    const result = service.calculateHealthScore('agent-1');

    // Only 1 filled execution should be counted; drawdown from the failed one should not appear
    const drawdownFactor = result!.factors.find((f) => f.name === 'drawdownSeverity')!;
    expect(drawdownFactor.normalizedScore).toBe(100); // no drawdown from single profitable trade
  });

  // ── 18. Multi-asset concentration scores higher ───────────────────
  it('scores multi-asset portfolio higher on concentration', () => {
    const state = createDefaultState();

    // Agent A: single asset
    state.agents['a1'] = makeAgent('a1', 'Single', {
      positions: { SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 } },
    });

    // Agent B: 4 equal assets
    state.agents['a2'] = makeAgent('a2', 'Multi', {
      positions: {
        SOL: { symbol: 'SOL', quantity: 25, avgEntryPriceUsd: 100 },
        BTC: { symbol: 'BTC', quantity: 0.0625, avgEntryPriceUsd: 40000 },
        ETH: { symbol: 'ETH', quantity: 1.25, avgEntryPriceUsd: 2000 },
        JTO: { symbol: 'JTO', quantity: 833, avgEntryPriceUsd: 3 },
      },
    });

    state.marketPricesUsd = { SOL: 100, BTC: 40000, ETH: 2000, JTO: 3 };

    const service = new DefiHealthScoreService(createMockStore(state));
    const r1 = service.calculateHealthScore('a1');
    const r2 = service.calculateHealthScore('a2');

    const conc1 = r1!.factors.find((f) => f.name === 'concentrationRisk')!.normalizedScore;
    const conc2 = r2!.factors.find((f) => f.name === 'concentrationRisk')!.normalizedScore;
    expect(conc2).toBeGreaterThan(conc1);
  });
});
