import { describe, expect, it, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { SelfImproveService } from '../src/services/selfImproveService.js';
import { InferenceBudgetService } from '../src/services/inferenceBudgetService.js';
import { ImprovementLoopService } from '../src/services/improvementLoopService.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { Agent, ExecutionRecord, AppState } from '../src/types.js';
import { eventBus } from '../src/infra/eventBus.js';
import { PerformanceAnalysis } from '../src/domain/improve/types.js';

let storeCounter = 0;

// ─── Helpers ────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    apiKey: 'test-key',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    startingCapitalUsd: 10_000,
    cashUsd: 10_000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10_000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 5_000,
      maxGrossExposureUsd: 50_000,
      dailyLossCapUsd: 2_000,
      maxDrawdownPct: 0.5,
      cooldownSeconds: 0,
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
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    intentId: 'intent-1',
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'buy',
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1_000,
    feeUsd: 1,
    netUsd: 999,
    realizedPnlUsd: 50,
    pnlSnapshotUsd: 50,
    mode: 'paper',
    status: 'filled',
    createdAt: '2025-01-01T14:00:00.000Z',
    ...overrides,
  };
}

async function createTestStore(agents: Agent[] = [], executions: ExecutionRecord[] = []): Promise<StateStore> {
  storeCounter += 1;
  const storePath = path.join(os.tmpdir(), `selfimprove-test-${Date.now()}-${storeCounter}.json`);
  const store = new StateStore(storePath);
  await store.init();

  await store.transaction((state: AppState) => {
    for (const agent of agents) {
      state.agents[agent.id] = agent;
    }
    for (const exec of executions) {
      state.executions[exec.id] = exec;
    }
    return undefined;
  });

  return store;
}

// ─── SelfImproveService Tests ───────────────────────────────────────────

describe('SelfImproveService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('analyzes performance with execution history', async () => {
    const agentId = 'agent-perf-analysis';
    const agent = makeAgent({ id: agentId });
    const executions = [
      makeExecution({ agentId, realizedPnlUsd: 50 }),
      makeExecution({ agentId, realizedPnlUsd: -20 }),
      makeExecution({ agentId, realizedPnlUsd: 30 }),
      makeExecution({ agentId, realizedPnlUsd: 80 }),
      makeExecution({ agentId, realizedPnlUsd: -10 }),
    ];

    const store = await createTestStore([agent], executions);
    const service = new SelfImproveService(store);

    const analysis = service.analyzePerformance(agentId);

    expect(analysis.agentId).toBe(agentId);
    expect(analysis.executionCount).toBe(5);
    expect(analysis.winRate).toBeGreaterThan(0);
    expect(analysis.analyzedAt).toBeTruthy();
    expect(analysis.bestStrategy).toBeTruthy();
    expect(analysis.worstStrategy).toBeTruthy();
  });

  it('returns empty analysis for agent with no executions', async () => {
    const agent = makeAgent({ id: 'agent-empty-history' });
    const store = await createTestStore([agent]);
    const service = new SelfImproveService(store);

    const analysis = service.analyzePerformance('agent-empty-history');

    expect(analysis.executionCount).toBe(0);
    expect(analysis.winRate).toBe(0);
    expect(analysis.avgReturnPct).toBe(0);
    expect(analysis.patterns).toHaveLength(0);
  });

  it('throws when analyzing non-existent agent', async () => {
    const store = await createTestStore();
    const service = new SelfImproveService(store);

    expect(() => service.analyzePerformance('no-such-agent'))
      .toThrow("Agent 'no-such-agent' not found.");
  });

  it('generates strategy-switch recommendation when strategies differ', async () => {
    const service = new SelfImproveService(await createTestStore());

    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 60,
      avgReturnPct: 2.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'mean-reversion-v1',
      riskRejectionRate: 10,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);

    const strategyRec = recs.find((r) => r.type === 'strategy-switch');
    expect(strategyRec).toBeDefined();
    expect(strategyRec!.parameters.toStrategy).toBe('momentum-v1');
    expect(strategyRec!.confidence).toBeGreaterThan(0);
    expect(strategyRec!.confidence).toBeLessThanOrEqual(1);
  });

  it('generates risk-adjustment recommendation when rejection rate is high', async () => {
    const service = new SelfImproveService(await createTestStore());

    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 60,
      avgReturnPct: 2.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'momentum-v1',
      riskRejectionRate: 35,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);

    const riskRec = recs.find((r) => r.type === 'risk-adjustment');
    expect(riskRec).toBeDefined();
    expect(riskRec!.description).toContain('35%');
  });

  it('generates low-win-rate risk-adjustment recommendation', async () => {
    const service = new SelfImproveService(await createTestStore());

    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 25,
      avgReturnPct: -1.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'momentum-v1',
      riskRejectionRate: 5,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);
    const tightenRec = recs.find(
      (r) => r.type === 'risk-adjustment' && r.description.includes('tighten'),
    );
    expect(tightenRec).toBeDefined();
    expect(tightenRec!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('applies a strategy-switch recommendation', async () => {
    const agent = makeAgent({ strategyId: 'mean-reversion-v1' });
    const store = await createTestStore([agent]);
    const service = new SelfImproveService(store);

    // Generate recommendations
    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 60,
      avgReturnPct: 2.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'mean-reversion-v1',
      riskRejectionRate: 5,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);
    const strategyRec = recs.find((r) => r.type === 'strategy-switch');
    expect(strategyRec).toBeDefined();

    const record = await service.applyRecommendation('agent-1', strategyRec!.id);

    expect(record.applied).toBe(true);
    expect(record.recommendation.type).toBe('strategy-switch');

    // Verify the agent's strategy was updated in the store
    const updatedAgent = store.snapshot().agents['agent-1'];
    expect(updatedAgent.strategyId).toBe('momentum-v1');
  });

  it('applies a risk-adjustment recommendation', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const service = new SelfImproveService(store);

    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 60,
      avgReturnPct: 2.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'momentum-v1',
      riskRejectionRate: 40,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);
    const riskRec = recs.find((r) => r.type === 'risk-adjustment' && r.parameters.adjustment === 'increase');
    expect(riskRec).toBeDefined();

    const originalNotional = agent.riskLimits.maxOrderNotionalUsd;
    await service.applyRecommendation('agent-1', riskRec!.id);

    const updated = store.snapshot().agents['agent-1'];
    expect(updated.riskLimits.maxOrderNotionalUsd).toBeGreaterThan(originalNotional);
  });

  it('throws when applying recommendation for unknown agent', async () => {
    const store = await createTestStore();
    const service = new SelfImproveService(store);

    await expect(service.applyRecommendation('no-agent', 'no-rec'))
      .rejects.toThrow("No recommendations found");
  });

  it('tracks improvement history', async () => {
    const agent = makeAgent({ strategyId: 'mean-reversion-v1' });
    const store = await createTestStore([agent]);
    const service = new SelfImproveService(store);

    const analysis: PerformanceAnalysis = {
      agentId: 'agent-1',
      analyzedAt: new Date().toISOString(),
      executionCount: 10,
      winRate: 60,
      avgReturnPct: 2.5,
      bestStrategy: 'momentum-v1',
      worstStrategy: 'mean-reversion-v1',
      riskRejectionRate: 5,
      patterns: [],
    };

    const recs = service.generateRecommendations(analysis);
    await service.applyRecommendation('agent-1', recs[0].id);

    const history = service.getImprovementHistory('agent-1');
    expect(history).toHaveLength(1);
    expect(history[0].applied).toBe(true);
    expect(history[0].agentId).toBe('agent-1');
  });

  it('emits improve.analyzed event', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const service = new SelfImproveService(store);

    const events: unknown[] = [];
    eventBus.on('improve.analyzed', (_type, data) => events.push(data));

    service.analyzePerformance('agent-1');
    expect(events).toHaveLength(1);
  });
});

// ─── InferenceBudgetService Tests ────────────────────────────────────────

describe('InferenceBudgetService', () => {
  it('allocates from profits correctly', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    const budget = service.allocateFromProfits('agent-1', 100);

    expect(budget.agentId).toBe('agent-1');
    expect(budget.totalAllocatedUsd).toBe(10); // 10% of 100
    expect(budget.availableUsd).toBe(10);
    expect(budget.inferenceAllocationPct).toBe(10);
  });

  it('does not allocate from negative profits', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    const budget = service.allocateFromProfits('agent-1', -50);
    expect(budget.totalAllocatedUsd).toBe(0);
  });

  it('records inference calls and deducts from budget', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    service.allocateFromProfits('agent-1', 100); // $10 budget

    const call = service.recordInferenceCall('agent-1', 2, 'openai', 'analysis');
    expect(call).not.toBeNull();
    expect(call!.costUsd).toBe(2);
    expect(call!.provider).toBe('openai');

    const budget = service.getInferenceBudget('agent-1');
    expect(budget.totalSpentUsd).toBe(2);
    expect(budget.availableUsd).toBe(8);
  });

  it('returns null when budget is exhausted', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    service.allocateFromProfits('agent-1', 10); // $1 budget

    const call = service.recordInferenceCall('agent-1', 5, 'openai', 'analysis');
    expect(call).toBeNull();
  });

  it('tracks inference history', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    service.allocateFromProfits('agent-1', 1000);
    service.recordInferenceCall('agent-1', 0.05, 'openai', 'analysis-1');
    service.recordInferenceCall('agent-1', 0.03, 'anthropic', 'analysis-2');

    const history = service.getInferenceHistory('agent-1');
    expect(history).toHaveLength(2);
    expect(history[0].provider).toBe('openai');
    expect(history[1].provider).toBe('anthropic');
  });

  it('computes ROI correctly', async () => {
    const agent = makeAgent({ realizedPnlUsd: 500 });
    const store = await createTestStore([agent]);
    const service = new InferenceBudgetService(store);

    service.setBaselinePnl('agent-1', 400); // PnL was 400 before inference
    service.allocateFromProfits('agent-1', 100);
    service.recordInferenceCall('agent-1', 5, 'openai', 'improvement');

    const roi = service.getROI('agent-1');
    expect(roi.agentId).toBe('agent-1');
    expect(roi.totalInferenceSpentUsd).toBe(5);
    expect(roi.profitImprovementUsd).toBe(100); // 500 - 400
    expect(roi.roi).toBe(20); // 100 / 5
    expect(roi.cyclesRun).toBe(1);
  });

  it('returns zero ROI when no inference spent', async () => {
    const store = await createTestStore();
    const service = new InferenceBudgetService(store);

    const roi = service.getROI('agent-1');
    expect(roi.roi).toBe(0);
    expect(roi.cyclesRun).toBe(0);
  });
});

// ─── ImprovementLoopService Tests ─────────────────────────────────────────

describe('ImprovementLoopService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('runs a full improvement cycle', async () => {
    const agent = makeAgent({
      realizedPnlUsd: 200,
      riskRejectionsByReason: { max_notional: 15 },
    });
    const executions = Array.from({ length: 10 }, (_, i) =>
      makeExecution({
        realizedPnlUsd: i % 3 === 0 ? -10 : 30,
        grossNotionalUsd: 500 + i * 100,
      }),
    );

    const store = await createTestStore([agent], executions);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    // Fund inference budget first
    budgetService.allocateFromProfits('agent-1', 100);

    const cycle = await loopService.runImprovementCycle('agent-1');

    expect(cycle.agentId).toBe('agent-1');
    expect(cycle.analysis).toBeDefined();
    expect(cycle.analysis.executionCount).toBeGreaterThanOrEqual(10);
    expect(cycle.recommendations).toBeDefined();
    expect(cycle.inferenceCost).toBeGreaterThanOrEqual(0);
    expect(typeof cycle.budgetRemaining).toBe('number');
    expect(cycle.timestamp).toBeTruthy();
  });

  it('auto-applies high-confidence recommendations', async () => {
    const agent = makeAgent({
      strategyId: 'mean-reversion-v1',
      riskRejectionsByReason: { max_notional: 30 },
    });

    // Create executions that trigger high-confidence recs
    // Low win rate → triggers tighten drawdown recommendation at confidence 0.75
    const executions = Array.from({ length: 10 }, (_, i) =>
      makeExecution({
        realizedPnlUsd: i < 3 ? 20 : -15,
        grossNotionalUsd: 1000,
      }),
    );

    const store = await createTestStore([agent], executions);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    budgetService.allocateFromProfits('agent-1', 100);

    const cycle = await loopService.runImprovementCycle('agent-1');

    // With a 30% win rate and high rejection rate, there should be recommendations
    expect(cycle.recommendations.length).toBeGreaterThan(0);

    // The cycle should try to auto-apply if any rec has confidence > 0.7
    const highConfRec = cycle.recommendations.find((r) => r.confidence >= 0.7);
    if (highConfRec) {
      expect(cycle.applied).not.toBeNull();
    }
  });

  it('tracks loop status', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    const status = loopService.getLoopStatus('agent-1');

    expect(status.agentId).toBe('agent-1');
    expect(status.enabled).toBe(false);
    expect(status.cyclesCompleted).toBe(0);
    expect(status.lastRunAt).toBeNull();
    expect(status.budget).toBeDefined();
  });

  it('enables and configures auto-improve', async () => {
    const store = await createTestStore();
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    const status = loopService.enableAutoImprove('agent-1', 50);

    expect(status.enabled).toBe(true);
    expect(status.intervalTicks).toBe(50);
  });

  it('tracks cycle history', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    budgetService.allocateFromProfits('agent-1', 100);

    await loopService.runImprovementCycle('agent-1');
    await loopService.runImprovementCycle('agent-1');

    const history = loopService.getCycleHistory('agent-1');
    expect(history).toHaveLength(2);
    expect(history[0].id).not.toBe(history[1].id);
  });

  it('emits improve.cycle event', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    budgetService.allocateFromProfits('agent-1', 100);

    const events: unknown[] = [];
    eventBus.on('improve.cycle', (_type, data) => events.push(data));

    await loopService.runImprovementCycle('agent-1');
    expect(events).toHaveLength(1);
  });

  it('handles cycle with insufficient budget gracefully', async () => {
    const agent = makeAgent();
    const store = await createTestStore([agent]);
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    // Don't fund budget — it'll be 0
    const cycle = await loopService.runImprovementCycle('agent-1');

    expect(cycle).toBeDefined();
    expect(cycle.inferenceCost).toBe(0); // No budget to charge
    expect(cycle.analysis).toBeDefined();
  });

  it('throws when running cycle for non-existent agent', async () => {
    const store = await createTestStore();
    const selfImprove = new SelfImproveService(store);
    const budgetService = new InferenceBudgetService(store);
    const loopService = new ImprovementLoopService(store, selfImprove, budgetService);

    await expect(loopService.runImprovementCycle('no-agent'))
      .rejects.toThrow("Agent 'no-agent' not found.");
  });
});
