import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PriceOracleService } from '../src/services/priceOracleService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(async (work: (s: AppState) => unknown) => {
      await work(state);
    }),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeFetchFn(price: number) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ solana: { usd: price } }),
  })) as any;
}

function makeFailingFetchFn() {
  return vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as any;
}

describe('PriceOracleService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('fetches SOL price from CoinGecko and stores it', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const fetchFn = makeFetchFn(142.5);
    const service = new PriceOracleService(store, { fetchFn });

    await service.fetchPrices();

    const price = service.getCurrentPrice('SOL');
    expect(price).not.toBeNull();
    expect(price!.priceUsd).toBe(142.5);
    expect(price!.source).toBe('coingecko');
    expect(price!.symbol).toBe('SOL');
  });

  it('feeds price into state store market prices', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const fetchFn = makeFetchFn(150.0);
    const service = new PriceOracleService(store, { fetchFn });

    await service.fetchPrices();

    expect(store.transaction).toHaveBeenCalled();
    // The transaction updates state.marketPricesUsd.SOL
    expect(state.marketPricesUsd['SOL']).toBe(150.0);
  });

  it('emits price.updated event on successful fetch', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const fetchFn = makeFetchFn(130.0);
    const service = new PriceOracleService(store, { fetchFn });

    const events: unknown[] = [];
    eventBus.on('price.updated', (_event, data) => events.push(data));

    await service.fetchPrices();

    expect(events.length).toBe(1);
    expect((events[0] as any).symbol).toBe('SOL');
    expect((events[0] as any).priceUsd).toBe(130.0);
  });

  it('falls back to last known price on API failure', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const successFetch = makeFetchFn(120.0);
    const service = new PriceOracleService(store, { fetchFn: successFetch });

    // First fetch succeeds
    await service.fetchPrices();
    expect(service.getCurrentPrice('SOL')!.priceUsd).toBe(120.0);

    // Replace with failing fetch
    const failFetch = makeFailingFetchFn();
    const service2 = new PriceOracleService(store, { fetchFn: failFetch });

    // Set the price first so there's a "last known"
    // Actually, the new service won't have the old price, so let's test with same service
    // by mocking the fetch to fail after first success
    const mixedFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ solana: { usd: 120.0 } }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const service3 = new PriceOracleService(store, { fetchFn: mixedFetch as any });
    await service3.fetchPrices(); // success
    await service3.fetchPrices(); // failure

    // Price should still be the last known
    expect(service3.getCurrentPrice('SOL')!.priceUsd).toBe(120.0);
  });

  it('tracks price history up to 100 data points', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    let callCount = 0;
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ solana: { usd: 100 + (callCount++) } }),
    })) as any;

    const service = new PriceOracleService(store, { fetchFn });

    // Fetch 5 times
    for (let i = 0; i < 5; i++) {
      await service.fetchPrices();
    }

    const history = service.getPriceHistory('SOL');
    expect(history.length).toBe(5);
    expect(history[0].priceUsd).toBe(100);
    expect(history[4].priceUsd).toBe(104);
  });

  it('limits history with limit parameter', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    let callCount = 0;
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ solana: { usd: 100 + (callCount++) } }),
    })) as any;

    const service = new PriceOracleService(store, { fetchFn });

    for (let i = 0; i < 10; i++) {
      await service.fetchPrices();
    }

    const history = service.getPriceHistory('SOL', 3);
    expect(history.length).toBe(3);
  });

  it('returns USDC price as static $1', () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const service = new PriceOracleService(store, { fetchFn: makeFetchFn(100) });

    const usdc = service.getCurrentPrice('USDC');
    expect(usdc).not.toBeNull();
    expect(usdc!.priceUsd).toBe(1);
    expect(usdc!.source).toBe('static');
  });

  it('returns oracle status with fetch count and error tracking', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const failFetch = makeFailingFetchFn();
    const service = new PriceOracleService(store, { fetchFn: failFetch });

    await service.fetchPrices();

    const status = service.getOracleStatus();
    expect(status.fetchCount).toBe(1);
    expect(status.errorCount).toBe(1);
    expect(status.lastErrorAt).not.toBeNull();
    expect(status.lastError).toContain('CoinGecko HTTP 500');
    expect(status.cacheTtlMs).toBe(30_000);
  });

  it('getAllPrices returns all cached prices', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const fetchFn = makeFetchFn(155.0);
    const service = new PriceOracleService(store, { fetchFn });

    await service.fetchPrices();

    const allPrices = service.getAllPrices();
    expect(allPrices.length).toBe(2); // USDC (seeded) + SOL
    const symbols = allPrices.map((p) => p.symbol);
    expect(symbols).toContain('SOL');
    expect(symbols).toContain('USDC');
  });

  it('returns null for unknown symbol', () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const service = new PriceOracleService(store, { fetchFn: makeFetchFn(100) });

    expect(service.getCurrentPrice('UNKNOWN')).toBeNull();
  });

  it('handles invalid JSON gracefully', async () => {
    const state = createDefaultState();
    const store = createMockStore(state);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ solana: {} }), // missing usd field
    })) as any;

    const service = new PriceOracleService(store, { fetchFn });
    await service.fetchPrices();

    const status = service.getOracleStatus();
    expect(status.errorCount).toBe(1);
    expect(status.lastError).toContain('Invalid SOL price');
  });
});
