import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WatchlistService } from '../src/services/watchlistService.js';
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

describe('WatchlistService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup() {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    state.marketPricesUsd['SOL'] = 100;
    state.marketPricesUsd['BONK'] = 0.00002;
    const store = createMockStore(state);
    const service = new WatchlistService(store);
    return { state, store, service };
  }

  it('adds a token to watchlist', () => {
    const { service } = setup();
    const entry = service.addToWatchlist('agent-1', 'SOL', 'bullish');

    expect(entry.id).toBeDefined();
    expect(entry.agentId).toBe('agent-1');
    expect(entry.symbol).toBe('SOL');
    expect(entry.notes).toBe('bullish');
    expect(entry.addedAt).toBeDefined();
  });

  it('normalizes symbol to uppercase', () => {
    const { service } = setup();
    const entry = service.addToWatchlist('agent-1', 'sol');
    expect(entry.symbol).toBe('SOL');
  });

  it('updates notes when adding duplicate symbol', () => {
    const { service } = setup();
    service.addToWatchlist('agent-1', 'SOL', 'bullish');
    const updated = service.addToWatchlist('agent-1', 'SOL', 'very bullish');

    expect(updated.notes).toBe('very bullish');

    const watchlist = service.getWatchlist('agent-1');
    expect(watchlist.length).toBe(1);
  });

  it('throws when adding for unknown agent', () => {
    const { service } = setup();
    expect(() => service.addToWatchlist('ghost', 'SOL')).toThrow('Agent not found');
  });

  it('removes a token from watchlist', () => {
    const { service } = setup();
    service.addToWatchlist('agent-1', 'SOL');
    const result = service.removeFromWatchlist('agent-1', 'SOL');

    expect(result.removed).toBe(true);

    const watchlist = service.getWatchlist('agent-1');
    expect(watchlist.length).toBe(0);
  });

  it('throws when removing non-existent token', () => {
    const { service } = setup();
    expect(() => service.removeFromWatchlist('agent-1', 'SOL')).toThrow('Token not found');
  });

  it('returns watchlist with current prices', () => {
    const { service } = setup();
    service.addToWatchlist('agent-1', 'SOL');
    service.addToWatchlist('agent-1', 'BONK');
    service.addToWatchlist('agent-1', 'UNKNOWN_TOKEN');

    const watchlist = service.getWatchlist('agent-1');
    expect(watchlist.length).toBe(3);

    const sol = watchlist.find((e) => e.symbol === 'SOL');
    expect(sol?.currentPriceUsd).toBe(100);

    const bonk = watchlist.find((e) => e.symbol === 'BONK');
    expect(bonk?.currentPriceUsd).toBe(0.00002);

    const unknown = watchlist.find((e) => e.symbol === 'UNKNOWN_TOKEN');
    expect(unknown?.currentPriceUsd).toBeNull();
  });

  it('throws when getting watchlist for unknown agent', () => {
    const { service } = setup();
    expect(() => service.getWatchlist('ghost')).toThrow('Agent not found');
  });

  it('returns trending tokens sorted by watch count', () => {
    const { service } = setup();
    // Agent 1 watches SOL and BONK
    service.addToWatchlist('agent-1', 'SOL');
    service.addToWatchlist('agent-1', 'BONK');
    // Agent 2 watches SOL
    service.addToWatchlist('agent-2', 'SOL');

    const trending = service.getTrending();
    expect(trending.length).toBe(2);
    expect(trending[0].symbol).toBe('SOL');
    expect(trending[0].watchCount).toBe(2);
    expect(trending[0].currentPriceUsd).toBe(100);
    expect(trending[1].symbol).toBe('BONK');
    expect(trending[1].watchCount).toBe(1);
  });

  it('returns empty trending when no watchlists', () => {
    const { service } = setup();
    const trending = service.getTrending();
    expect(trending).toEqual([]);
  });

  it('emits watchlist.added event', () => {
    const { service } = setup();
    const events: unknown[] = [];
    eventBus.on('watchlist.added', (_event, data) => events.push(data));

    service.addToWatchlist('agent-1', 'SOL');
    expect(events.length).toBe(1);
    expect((events[0] as any).symbol).toBe('SOL');
  });

  it('emits watchlist.removed event', () => {
    const { service } = setup();
    const events: unknown[] = [];
    eventBus.on('watchlist.removed', (_event, data) => events.push(data));

    service.addToWatchlist('agent-1', 'SOL');
    service.removeFromWatchlist('agent-1', 'SOL');

    expect(events.length).toBe(1);
    expect((events[0] as any).symbol).toBe('SOL');
  });
});
