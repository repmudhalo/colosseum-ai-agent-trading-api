import { describe, expect, it, beforeEach } from 'vitest';
import { AgentLearningService, MarketRegime } from '../src/services/agentLearningService.js';
import { AppState, Agent, ExecutionRecord } from '../src/types.js';
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

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10000,
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

function makeExecution(id: string, agentId: string, overrides?: Partial<ExecutionRecord>): ExecutionRecord {
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
    realizedPnlUsd: 50,
    pnlSnapshotUsd: 50,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentLearningService', () => {
  let service: AgentLearningService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Test Bot');
    const store = createMockStore(state);
    service = new AgentLearningService(store);
  });

  // ─── Pattern Recognition ──────────────────────────────────────────

  it('analyzes trade patterns for an agent with winning trades', () => {
    // Create winning buy trades for SOL
    for (let i = 0; i < 5; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        symbol: 'SOL',
        side: 'buy',
        realizedPnlUsd: 50 + i * 10,
        createdAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const patterns = service.analyzePatterns('agent-1');
    expect(patterns.agentId).toBe('agent-1');
    expect(patterns.totalPatternsAnalyzed).toBeGreaterThanOrEqual(1);
    expect(patterns.overallWinRate).toBe(1);
    expect(patterns.patterns.length).toBeGreaterThanOrEqual(1);

    const solBuyPattern = patterns.patterns.find((p) => p.symbol === 'SOL' && p.side === 'buy');
    expect(solBuyPattern).toBeDefined();
    expect(solBuyPattern!.winRate).toBe(1);
    expect(solBuyPattern!.wins).toBe(5);
    expect(solBuyPattern!.losses).toBe(0);
    expect(solBuyPattern!.tags).toContain('high-win-rate');
    expect(solBuyPattern!.tags).toContain('positive-expectancy');
  });

  it('identifies losing patterns correctly', () => {
    for (let i = 0; i < 5; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        symbol: 'BONK',
        side: 'sell',
        realizedPnlUsd: -(20 + i * 5),
        createdAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const patterns = service.analyzePatterns('agent-1');
    const bonkSellPattern = patterns.patterns.find((p) => p.symbol === 'BONK' && p.side === 'sell');
    expect(bonkSellPattern).toBeDefined();
    expect(bonkSellPattern!.winRate).toBe(0);
    expect(bonkSellPattern!.losses).toBe(5);
    expect(bonkSellPattern!.tags).toContain('low-win-rate');
    expect(bonkSellPattern!.tags).toContain('negative-expectancy');
    expect(patterns.topLosingPatterns.length).toBeGreaterThanOrEqual(1);
  });

  it('separates top winning and top losing patterns', () => {
    // Winning SOL buys
    for (let i = 0; i < 3; i++) {
      state.executions[`win-${i}`] = makeExecution(`win-${i}`, 'agent-1', {
        symbol: 'SOL',
        side: 'buy',
        realizedPnlUsd: 100,
      });
    }
    // Losing BONK sells
    for (let i = 0; i < 3; i++) {
      state.executions[`loss-${i}`] = makeExecution(`loss-${i}`, 'agent-1', {
        symbol: 'BONK',
        side: 'sell',
        realizedPnlUsd: -80,
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const patterns = service.analyzePatterns('agent-1');
    expect(patterns.topWinningPatterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns.topLosingPatterns.length).toBeGreaterThanOrEqual(1);

    // The winning patterns have positive expectancy
    for (const p of patterns.topWinningPatterns) {
      expect(p.expectancy).toBeGreaterThan(0);
    }
    // The losing patterns have negative expectancy
    for (const p of patterns.topLosingPatterns) {
      expect(p.expectancy).toBeLessThan(0);
    }
  });

  it('returns empty patterns when no trades exist', () => {
    const patterns = service.analyzePatterns('agent-1');
    expect(patterns.totalPatternsAnalyzed).toBe(0);
    expect(patterns.patterns).toEqual([]);
    expect(patterns.overallWinRate).toBe(0);
  });

  // ─── Market Regime Detection ──────────────────────────────────────

  it('detects trending-up regime from rising prices', () => {
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 20 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 100 + i * 3, // steady rise: 100 → 157
    }));

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const regime = service.detectRegime('SOL');
    expect(regime.symbol).toBe('SOL');
    expect(regime.regime).toBe('trending-up');
    expect(regime.confidence).toBeGreaterThan(0);
    expect(regime.trendStrength).toBeGreaterThan(0);
    expect(regime.avgReturn).toBeGreaterThan(0);
    expect(regime.priceRange.high).toBeGreaterThan(regime.priceRange.low);
  });

  it('detects trending-down regime from falling prices', () => {
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 20 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 200 - i * 3, // steady fall: 200 → 143
    }));

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const regime = service.detectRegime('SOL');
    expect(regime.regime).toBe('trending-down');
    expect(regime.avgReturn).toBeLessThan(0);
  });

  it('detects unknown regime with insufficient data', () => {
    state.marketPriceHistoryUsd['SOL'] = [
      { ts: new Date().toISOString(), priceUsd: 100 },
    ];

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const regime = service.detectRegime('SOL');
    expect(regime.regime).toBe('unknown');
    expect(regime.confidence).toBe(0);
    expect(regime.dataPoints).toBeLessThanOrEqual(2);
  });

  it('normalizes symbol to uppercase in regime detection', () => {
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 5 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 100 + i,
    }));

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const regime = service.detectRegime('sol');
    expect(regime.symbol).toBe('SOL');
  });

  // ─── Adaptive Parameter Tuning ────────────────────────────────────

  it('suggests increasing position size when win rate is high', () => {
    // Create high win-rate executions
    for (let i = 0; i < 10; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: i < 8 ? 50 : -20, // 80% win rate
        createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const adapted = service.adaptParameters('agent-1');
    expect(adapted.agentId).toBe('agent-1');
    expect(adapted.adjustments.length).toBeGreaterThanOrEqual(1);

    const positionAdj = adapted.adjustments.find((a) => a.parameter === 'maxPositionSizePct');
    if (positionAdj) {
      expect(positionAdj.newValue).toBeGreaterThan(positionAdj.previousValue);
      expect(positionAdj.reason).toContain('win rate');
    }
  });

  it('suggests reducing position size when win rate is low', () => {
    // Create low win-rate executions
    for (let i = 0; i < 10; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: i < 2 ? 30 : -40, // 20% win rate
        createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const adapted = service.adaptParameters('agent-1');
    const positionAdj = adapted.adjustments.find((a) => a.parameter === 'maxPositionSizePct');
    expect(positionAdj).toBeDefined();
    expect(positionAdj!.newValue).toBeLessThan(positionAdj!.previousValue);
  });

  it('returns no adjustments when insufficient trades', () => {
    // Only 1 trade, not enough
    state.executions['ex-1'] = makeExecution('ex-1', 'agent-1');

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const adapted = service.adaptParameters('agent-1');
    expect(adapted.adjustments).toEqual([]);
    expect(adapted.previousParams).toEqual(adapted.suggestedParams);
  });

  // ─── Confidence Scoring ───────────────────────────────────────────

  it('computes confidence score for a symbol with trade history', () => {
    // Create mixed trades
    for (let i = 0; i < 15; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        symbol: 'SOL',
        side: 'buy',
        realizedPnlUsd: i % 3 === 0 ? -20 : 40, // ~67% win rate
        createdAt: new Date(Date.now() - (15 - i) * 60_000).toISOString(),
      });
    }

    // Add some price history for regime detection
    const now = Date.now();
    state.marketPriceHistoryUsd['SOL'] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(now + i * 60_000).toISOString(),
      priceUsd: 100 + i * 2,
    }));

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const confidence = service.scoreConfidence('agent-1', 'SOL');
    expect(confidence.symbol).toBe('SOL');
    expect(confidence.confidence).toBeGreaterThan(0);
    expect(confidence.confidence).toBeLessThanOrEqual(100);
    expect(confidence.historicalAccuracy).toBeGreaterThan(0);
    expect(confidence.sampleSize).toBe(15);
    expect(confidence.factors.length).toBe(5);
    expect(confidence.timestamp).toBeDefined();

    // Check all factors are present
    const factorNames = confidence.factors.map((f) => f.name);
    expect(factorNames).toContain('historical_accuracy');
    expect(factorNames).toContain('sample_size');
    expect(factorNames).toContain('recent_trend');
    expect(factorNames).toContain('regime_alignment');
    expect(factorNames).toContain('profit_factor');
  });

  it('returns baseline confidence when no trades exist for symbol', () => {
    const confidence = service.scoreConfidence('agent-1', 'SOL');
    expect(confidence.symbol).toBe('SOL');
    expect(confidence.sampleSize).toBe(0);
    expect(confidence.historicalAccuracy).toBe(50); // default 50%
    expect(confidence.confidence).toBeGreaterThanOrEqual(0);
    expect(confidence.confidence).toBeLessThanOrEqual(100);
  });

  // ─── Learning Metrics Dashboard ───────────────────────────────────

  it('returns comprehensive learning metrics', () => {
    // Create some trades
    for (let i = 0; i < 8; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: i % 2 === 0 ? 30 : -15,
        createdAt: new Date(Date.now() - (8 - i) * 60_000).toISOString(),
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    // Run some learning to populate knowledge
    service.analyzePatterns('agent-1');
    service.adaptParameters('agent-1');

    const metrics = service.getLearningMetrics('agent-1');
    expect(metrics.agentId).toBe('agent-1');
    expect(metrics.totalTradesAnalyzed).toBe(8);
    expect(metrics.knowledgeBaseSize).toBeGreaterThanOrEqual(1);
    expect(metrics.adaptationCount).toBeGreaterThanOrEqual(1);
    expect(metrics.recentAccuracy).toBeGreaterThanOrEqual(0);
    expect(metrics.recentAccuracy).toBeLessThanOrEqual(100);
    expect(metrics.regimesDetected).toBeDefined();
    expect(metrics.timestamp).toBeDefined();
    expect(metrics.lastLearningCycleAt).toBeDefined();
  });

  it('returns zero metrics for agent with no activity', () => {
    const metrics = service.getLearningMetrics('agent-1');
    expect(metrics.totalTradesAnalyzed).toBe(0);
    expect(metrics.knowledgeBaseSize).toBe(0);
    expect(metrics.adaptationCount).toBe(0);
    expect(metrics.recentAccuracy).toBe(0);
    expect(metrics.learningRate).toBe(0);
    expect(metrics.lastLearningCycleAt).toBeNull();
  });

  // ─── Knowledge Persistence ────────────────────────────────────────

  it('persists knowledge entries across multiple analysis cycles', () => {
    for (let i = 0; i < 5; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: 25,
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    service.analyzePatterns('agent-1');
    const knowledge1 = service.getKnowledge('agent-1');
    expect(knowledge1.length).toBeGreaterThanOrEqual(1);

    // Analyze again — should update, not duplicate
    service.analyzePatterns('agent-1');
    const knowledge2 = service.getKnowledge('agent-1');
    expect(knowledge2.length).toBe(knowledge1.length);

    // Access count should increase
    const entry = knowledge2.find((k) => k.key === 'trade-patterns');
    expect(entry).toBeDefined();
    expect(entry!.accessCount).toBe(2);
  });

  // ─── Profit Factor & Expectancy ───────────────────────────────────

  it('computes correct profit factor and expectancy', () => {
    // 3 wins of $100 each, 2 losses of $50 each → PF = 300/100 = 3.0
    const trades = [
      { pnl: 100 }, { pnl: 100 }, { pnl: 100 }, { pnl: -50 }, { pnl: -50 },
    ];
    for (let i = 0; i < trades.length; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        symbol: 'JUP',
        side: 'buy',
        realizedPnlUsd: trades[i].pnl,
      });
    }

    const store = createMockStore(state);
    service = new AgentLearningService(store);

    const patterns = service.analyzePatterns('agent-1');
    const jupPattern = patterns.patterns.find((p) => p.symbol === 'JUP');
    expect(jupPattern).toBeDefined();
    expect(jupPattern!.profitFactor).toBe(3);
    expect(jupPattern!.expectancy).toBeGreaterThan(0);
    expect(jupPattern!.winRate).toBe(0.6);
    expect(jupPattern!.avgWinPnl).toBe(100);
    expect(jupPattern!.avgLossPnl).toBe(50);
    expect(jupPattern!.bestTrade).toBe(100);
    expect(jupPattern!.worstTrade).toBe(-50);
  });
});
