import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TradeHistoryService } from '../src/services/tradeHistoryService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

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

function makeExecution(overrides?: Record<string, unknown>) {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
    intentId: `intent-${Math.random().toString(36).slice(2, 8)}`,
    symbol: 'SOL',
    side: 'buy' as const,
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 1,
    netUsd: 999,
    realizedPnlUsd: 0,
    mode: 'paper' as const,
    ...overrides,
  };
}

describe('TradeHistoryService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup() {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    const store = createMockStore(state);
    const service = new TradeHistoryService(store);
    return { state, store, service };
  }

  it('records a trade', () => {
    const { service } = setup();
    const record = service.recordTrade('agent-1', makeExecution());

    expect(record.id).toBeDefined();
    expect(record.agentId).toBe('agent-1');
    expect(record.symbol).toBe('SOL');
    expect(record.side).toBe('buy');
    expect(record.grossNotionalUsd).toBe(1000);
    expect(record.recordedAt).toBeDefined();
    expect(record.day).toBeDefined();
  });

  it('gets trade history with pagination', () => {
    const { service } = setup();

    for (let i = 0; i < 10; i++) {
      service.recordTrade('agent-1', makeExecution({ executionId: `exec-${i}` }));
    }

    const page1 = service.getTradeHistory('agent-1', { limit: 3 });
    expect(page1.trades.length).toBe(3);
    expect(page1.total).toBe(10);

    const page2 = service.getTradeHistory('agent-1', { limit: 3, offset: 3 });
    expect(page2.trades.length).toBe(3);
  });

  it('filters trade history by symbol', () => {
    const { service } = setup();
    service.recordTrade('agent-1', makeExecution({ symbol: 'SOL' }));
    service.recordTrade('agent-1', makeExecution({ symbol: 'BONK' }));
    service.recordTrade('agent-1', makeExecution({ symbol: 'SOL' }));

    const result = service.getTradeHistory('agent-1', { symbol: 'SOL' });
    expect(result.total).toBe(2);
    expect(result.trades.every((t) => t.symbol === 'SOL')).toBe(true);
  });

  it('filters trade history by side', () => {
    const { service } = setup();
    service.recordTrade('agent-1', makeExecution({ side: 'buy' }));
    service.recordTrade('agent-1', makeExecution({ side: 'sell' }));
    service.recordTrade('agent-1', makeExecution({ side: 'buy' }));

    const result = service.getTradeHistory('agent-1', { side: 'sell' });
    expect(result.total).toBe(1);
    expect(result.trades[0].side).toBe('sell');
  });

  it('throws when getting history for unknown agent', () => {
    const { service } = setup();
    expect(() => service.getTradeHistory('ghost')).toThrow('Agent not found');
  });

  it('computes performance summary', () => {
    const { service } = setup();
    service.recordTrade('agent-1', makeExecution({ grossNotionalUsd: 1000, realizedPnlUsd: 50 }));
    service.recordTrade('agent-1', makeExecution({ grossNotionalUsd: 2000, realizedPnlUsd: -30 }));
    service.recordTrade('agent-1', makeExecution({ grossNotionalUsd: 500, realizedPnlUsd: 20 }));

    const summary = service.getPerformanceSummary('agent-1');
    expect(summary.totalTrades).toBe(3);
    expect(summary.totalVolume).toBe(3500);
    expect(summary.totalPnl).toBe(40);
    expect(summary.avgTradeSize).toBeCloseTo(1166.67, 1);
    expect(summary.bestTrade?.pnl).toBe(50);
    expect(summary.worstTrade?.pnl).toBe(-30);
    expect(summary.winCount).toBe(2);
    expect(summary.lossCount).toBe(1);
    expect(summary.winRate).toBeCloseTo(66.67, 1);
    expect(summary.dailyBreakdown.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty performance summary for agent with no trades', () => {
    const { service } = setup();
    const summary = service.getPerformanceSummary('agent-1');

    expect(summary.totalTrades).toBe(0);
    expect(summary.totalPnl).toBe(0);
    expect(summary.bestTrade).toBeNull();
    expect(summary.worstTrade).toBeNull();
  });

  it('throws when getting performance for unknown agent', () => {
    const { service } = setup();
    expect(() => service.getPerformanceSummary('ghost')).toThrow('Agent not found');
  });

  it('computes win/loss streaks', () => {
    const { service } = setup();
    // Win, Win, Loss, Win, Win, Win
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 10 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 20 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: -5 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 15 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 10 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 5 }));

    const streaks = service.getStreaks('agent-1');
    expect(streaks.currentStreak.type).toBe('win');
    expect(streaks.currentStreak.length).toBe(3);
    expect(streaks.longestWinStreak).toBe(3);
    expect(streaks.longestLossStreak).toBe(1);
  });

  it('returns no streak for agent with no trades', () => {
    const { service } = setup();
    const streaks = service.getStreaks('agent-1');

    expect(streaks.currentStreak.type).toBe('none');
    expect(streaks.currentStreak.length).toBe(0);
    expect(streaks.longestWinStreak).toBe(0);
    expect(streaks.longestLossStreak).toBe(0);
  });

  it('throws when getting streaks for unknown agent', () => {
    const { service } = setup();
    expect(() => service.getStreaks('ghost')).toThrow('Agent not found');
  });

  it('auto-records trades from eventBus intent.executed', () => {
    const { service } = setup();
    service.startListening();

    eventBus.emit('intent.executed', {
      executionId: 'exec-auto',
      intentId: 'intent-auto',
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      quantity: 5,
      priceUsd: 100,
      grossNotionalUsd: 500,
      feeUsd: 0.5,
      netUsd: 499.5,
      realizedPnlUsd: 10,
      mode: 'paper',
    });

    const history = service.getTradeHistory('agent-1');
    expect(history.total).toBe(1);
    expect(history.trades[0].executionId).toBe('exec-auto');

    service.stopListening();
  });

  it('handles break-even trades in streak calculation', () => {
    const { service } = setup();
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 10 }));
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: 0 }));   // break-even
    service.recordTrade('agent-1', makeExecution({ realizedPnlUsd: -5 }));

    const streaks = service.getStreaks('agent-1');
    expect(streaks.currentStreak.type).toBe('loss');
    expect(streaks.currentStreak.length).toBe(1);
  });

  it('isolates trade history between agents', () => {
    const { service } = setup();
    service.recordTrade('agent-1', makeExecution());
    service.recordTrade('agent-1', makeExecution());
    service.recordTrade('agent-2', makeExecution());

    const h1 = service.getTradeHistory('agent-1');
    const h2 = service.getTradeHistory('agent-2');

    expect(h1.total).toBe(2);
    expect(h2.total).toBe(1);
  });
});
