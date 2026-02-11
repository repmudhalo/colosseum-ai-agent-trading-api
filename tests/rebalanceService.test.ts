import { describe, expect, it, vi } from 'vitest';
import { RebalanceService } from '../src/services/rebalanceService.js';
import { AppState, Agent } from '../src/types.js';
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
    startingCapitalUsd: 10000,
    cashUsd: 4000,
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

describe('RebalanceService', () => {
  function setup(agentOverrides?: Partial<Agent>) {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1', agentOverrides);
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['USDC'] = 1;
    const store = createMockStore(state);
    const service = new RebalanceService(store);
    return { state, store, service };
  }

  it('sets target allocation for an agent', () => {
    const { service } = setup();
    const allocation = service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    expect(allocation['SOL']).toBe(0.6);
    expect(allocation['USDC']).toBe(0.4);
  });

  it('rejects target allocation for unknown agent', () => {
    const { service } = setup();
    expect(() =>
      service.setTargetAllocation('ghost', { SOL: 0.6, USDC: 0.4 }),
    ).toThrow('Agent not found');
  });

  it('rejects allocations that do not sum to 1', () => {
    const { service } = setup();
    expect(() =>
      service.setTargetAllocation('agent-1', { SOL: 0.5, USDC: 0.3 }),
    ).toThrow('must sum to 1');
  });

  it('rejects empty allocations', () => {
    const { service } = setup();
    expect(() =>
      service.setTargetAllocation('agent-1', {}),
    ).toThrow('must not be empty');
  });

  it('calculates rebalance with correct drift', () => {
    // Agent has $4000 cash (USDC) and no SOL positions
    // Total equity = $4000 = 100% USDC
    // Target: SOL 60%, USDC 40%
    const { service } = setup({ cashUsd: 4000, positions: {} });

    service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    const status = service.calculateRebalance('agent-1');

    expect(status.agentId).toBe('agent-1');
    expect(status.equityUsd).toBe(4000);

    const solDrift = status.drift.find((d) => d.symbol === 'SOL');
    expect(solDrift).toBeDefined();
    expect(solDrift!.targetPct).toBe(60);
    expect(solDrift!.currentPct).toBe(0); // no SOL positions
    expect(solDrift!.driftPct).toBe(-60); // 60% under target

    expect(status.needsRebalance).toBe(true);
    expect(status.suggestedTrades.length).toBeGreaterThan(0);
  });

  it('suggests buy trades when under-allocated', () => {
    const { service } = setup({ cashUsd: 10000, positions: {} });

    service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    const status = service.calculateRebalance('agent-1');

    const solTrade = status.suggestedTrades.find((t) => t.symbol === 'SOL');
    expect(solTrade).toBeDefined();
    expect(solTrade!.side).toBe('buy');
    expect(solTrade!.notionalUsd).toBe(6000); // 60% of 10000
  });

  it('suggests sell trades when over-allocated', () => {
    // Agent has $0 cash and 100 SOL at $100 each = $10,000 in SOL
    const { service } = setup({
      cashUsd: 0,
      positions: {
        SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 },
      },
    });

    service.setTargetAllocation('agent-1', { SOL: 0.4, USDC: 0.6 });
    const status = service.calculateRebalance('agent-1');

    const solTrade = status.suggestedTrades.find((t) => t.symbol === 'SOL');
    expect(solTrade).toBeDefined();
    expect(solTrade!.side).toBe('sell');
    expect(solTrade!.notionalUsd).toBe(6000); // need to sell 60% of SOL value
  });

  it('does not suggest trades when drift is below threshold', () => {
    // Agent has $4000 cash, 60 SOL at $100 = $6000 in SOL, total = $10000
    // That's already 60% SOL, 40% USDC — matches target
    const { service } = setup({
      cashUsd: 4000,
      positions: {
        SOL: { symbol: 'SOL', quantity: 60, avgEntryPriceUsd: 100 },
      },
    });

    service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    const status = service.calculateRebalance('agent-1');

    expect(status.needsRebalance).toBe(false);
    expect(status.suggestedTrades.length).toBe(0);
  });

  it('throws when no target allocation set', () => {
    const { service } = setup();
    expect(() => service.calculateRebalance('agent-1')).toThrow('No target allocation');
  });

  it('executeRebalance returns empty when no rebalance needed', () => {
    const { service } = setup({
      cashUsd: 4000,
      positions: {
        SOL: { symbol: 'SOL', quantity: 60, avgEntryPriceUsd: 100 },
      },
    });

    service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    const result = service.executeRebalance('agent-1');

    expect(result.tradesCreated).toBe(0);
    expect(result.trades.length).toBe(0);
  });

  it('executeRebalance returns trades when rebalance is needed', () => {
    const { service } = setup({ cashUsd: 10000, positions: {} });

    service.setTargetAllocation('agent-1', { SOL: 0.6, USDC: 0.4 });
    const result = service.executeRebalance('agent-1');

    expect(result.tradesCreated).toBeGreaterThan(0);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0].symbol).toBe('SOL');
    expect(result.trades[0].side).toBe('buy');
  });

  it('normalizes symbols to uppercase', () => {
    const { service } = setup();
    const allocation = service.setTargetAllocation('agent-1', { sol: 0.6, usdc: 0.4 });
    expect(allocation['SOL']).toBe(0.6);
    expect(allocation['USDC']).toBe(0.4);
  });

  it('getTargetAllocation returns null when not set', () => {
    const { service } = setup();
    expect(service.getTargetAllocation('agent-1')).toBeNull();
  });
});
