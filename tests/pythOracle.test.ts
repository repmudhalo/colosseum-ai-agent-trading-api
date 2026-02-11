import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PythOracleService } from '../src/services/pythOracleService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

/* ─── Helpers ──────────────────────────────────────────────────────────── */

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

function createMockExecutionService(state: AppState) {
  return {
    setMarketPrice: vi.fn(async (symbol: string, price: number) => {
      state.marketPricesUsd[symbol.toUpperCase()] = price;
    }),
  } as any;
}

/**
 * Build a mock Pyth Hermes response for the given symbol → price pairs.
 */
function makePythResponse(entries: Array<{ symbol: string; price: number; expo?: number; conf?: number }>) {
  const PYTH_PRICE_IDS: Record<string, string> = {
    SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  };

  return {
    parsed: entries.map((e) => {
      const expo = e.expo ?? -8;
      const rawPrice = Math.round(e.price / Math.pow(10, expo));
      const conf = e.conf ? Math.round(e.conf / Math.pow(10, expo)) : 1000;
      return {
        id: PYTH_PRICE_IDS[e.symbol.toUpperCase()] ?? 'unknown',
        price: {
          price: String(rawPrice),
          conf: String(conf),
          expo,
          publish_time: Math.floor(Date.now() / 1000),
        },
        ema_price: {
          price: String(rawPrice),
          conf: String(conf),
          expo,
          publish_time: Math.floor(Date.now() / 1000),
        },
      };
    }),
  };
}

function makeFetchFn(responseData: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => responseData,
  })) as any;
}

function makeFailingFetchFn(status = 500) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as any;
}

/* ─── Tests ────────────────────────────────────────────────────────────── */

describe('PythOracleService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  /* ─── Symbol mapping ─────────────────────────────────────────────────── */

  describe('symbol mapping', () => {
    it('returns supported symbols', () => {
      const symbols = PythOracleService.getSupportedSymbols();
      expect(symbols).toContain('SOL');
      expect(symbols).toContain('BTC');
      expect(symbols).toContain('ETH');
    });

    it('returns price ID for known symbol', () => {
      const id = PythOracleService.getPriceId('SOL');
      expect(id).toBe('0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');
    });

    it('returns price ID case-insensitively', () => {
      expect(PythOracleService.getPriceId('sol')).toBe(PythOracleService.getPriceId('SOL'));
    });

    it('returns undefined for unknown symbol', () => {
      expect(PythOracleService.getPriceId('DOGE')).toBeUndefined();
    });
  });

  /* ─── Single price fetch ─────────────────────────────────────────────── */

  describe('fetchPythPrice', () => {
    it('fetches SOL price and computes correctly from Pyth response', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 142.5 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      const entry = await service.fetchPythPrice('SOL');

      expect(entry.symbol).toBe('SOL');
      expect(entry.priceUsd).toBeCloseTo(142.5, 1);
      expect(entry.source).toBe('pyth');
      expect(entry.fetchedAt).toBeTruthy();
    });

    it('fetches BTC price correctly', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'BTC', price: 65432.10 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      const entry = await service.fetchPythPrice('BTC');

      expect(entry.symbol).toBe('BTC');
      expect(entry.priceUsd).toBeCloseTo(65432.10, 0);
    });

    it('stores fetched price for later retrieval', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'ETH', price: 3200.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.fetchPythPrice('ETH');

      const stored = service.getPrice('ETH');
      expect(stored).not.toBeNull();
      expect(stored!.priceUsd).toBeCloseTo(3200.0, 0);
    });

    it('is case-insensitive for symbol', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 150.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      const entry = await service.fetchPythPrice('sol');

      expect(entry.symbol).toBe('SOL');
    });

    it('throws for unsupported symbol', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      await expect(service.fetchPythPrice('DOGE')).rejects.toThrow('Unsupported Pyth symbol');
    });

    it('throws on HTTP error', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFailingFetchFn(503) });

      await expect(service.fetchPythPrice('SOL')).rejects.toThrow('Pyth Hermes HTTP 503');
    });

    it('throws on empty parsed array', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = makeFetchFn({ parsed: [] });

      const service = new PythOracleService(store, exec, { fetchFn });
      await expect(service.fetchPythPrice('SOL')).rejects.toThrow('no parsed data');
    });

    it('throws on malformed price data', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = makeFetchFn({
        parsed: [{ id: 'test', price: { price: null, expo: -8 } }],
      });

      const service = new PythOracleService(store, exec, { fetchFn });
      await expect(service.fetchPythPrice('SOL')).rejects.toThrow('malformed price data');
    });

    it('throws on missing parsed field', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = makeFetchFn({ something: 'else' });

      const service = new PythOracleService(store, exec, { fetchFn });
      await expect(service.fetchPythPrice('SOL')).rejects.toThrow('no parsed data');
    });
  });

  /* ─── Multi-symbol fetch ─────────────────────────────────────────────── */

  describe('fetchMultiplePythPrices', () => {
    it('fetches multiple symbols at once', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([
        { symbol: 'SOL', price: 142.0 },
        { symbol: 'BTC', price: 65000.0 },
      ]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      const entries = await service.fetchMultiplePythPrices(['SOL', 'BTC']);

      expect(entries.length).toBe(2);
      const symbols = entries.map((e) => e.symbol);
      expect(symbols).toContain('SOL');
      expect(symbols).toContain('BTC');
    });

    it('filters out unknown symbols gracefully', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 142.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      const entries = await service.fetchMultiplePythPrices(['SOL', 'DOGE']);

      expect(entries.length).toBe(1);
      expect(entries[0].symbol).toBe('SOL');
    });

    it('throws when no valid symbols provided', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      await expect(service.fetchMultiplePythPrices(['DOGE', 'SHIB'])).rejects.toThrow('No valid Pyth symbols');
    });
  });

  /* ─── Auto-feed start/stop ───────────────────────────────────────────── */

  describe('auto-feed lifecycle', () => {
    it('starts feed and updates prices + state store', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 155.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      // After start, should have fetched once immediately
      const status = service.getPythStatus();
      expect(status.running).toBe(true);
      expect(status.symbols).toEqual(['SOL']);
      expect(status.updateCount).toBe(1);
      expect(exec.setMarketPrice).toHaveBeenCalledWith('SOL', expect.closeTo(155.0, 0));

      service.stopPythFeed();
    });

    it('emits price.updated event on feed tick', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 160.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const events: unknown[] = [];
      eventBus.on('price.updated', (_event, data) => events.push(data));

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      expect(events.length).toBe(1);
      expect((events[0] as any).symbol).toBe('SOL');
      expect((events[0] as any).source).toBe('pyth');

      service.stopPythFeed();
    });

    it('stops feed and clears state', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 150.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      service.stopPythFeed();

      const status = service.getPythStatus();
      expect(status.running).toBe(false);
      expect(status.symbols).toEqual([]);
    });

    it('restarts feed when called again while running', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([
        { symbol: 'SOL', price: 150.0 },
        { symbol: 'BTC', price: 65000.0 },
      ]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);
      await service.startPythFeed(['SOL', 'BTC'], 30_000);

      const status = service.getPythStatus();
      expect(status.running).toBe(true);
      expect(status.symbols).toEqual(['SOL', 'BTC']);
      expect(status.intervalMs).toBe(30_000);

      service.stopPythFeed();
    });

    it('throws when starting feed with no valid symbols', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      await expect(service.startPythFeed(['DOGE'], 30_000)).rejects.toThrow('No valid Pyth symbols');
    });
  });

  /* ─── Status reporting ───────────────────────────────────────────────── */

  describe('status reporting', () => {
    it('reports correct initial status', () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      const status = service.getPythStatus();
      expect(status.running).toBe(false);
      expect(status.symbols).toEqual([]);
      expect(status.updateCount).toBe(0);
      expect(status.errorCount).toBe(0);
      expect(status.lastUpdateAt).toBeNull();
      expect(status.lastErrorAt).toBeNull();
      expect(status.lastError).toBeNull();
    });

    it('tracks error count on feed failure', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = makeFailingFetchFn(500);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      const status = service.getPythStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toContain('Pyth Hermes HTTP 500');
      expect(status.lastErrorAt).not.toBeNull();
      // Feed is still running (it just had an error tick)
      expect(status.running).toBe(true);

      service.stopPythFeed();
    });

    it('includes fetched prices in status', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const pythData = makePythResponse([{ symbol: 'SOL', price: 170.0 }]);
      const fetchFn = makeFetchFn(pythData);

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      const status = service.getPythStatus();
      expect(status.prices['SOL']).toBeDefined();
      expect(status.prices['SOL'].priceUsd).toBeCloseTo(170.0, 0);

      service.stopPythFeed();
    });
  });

  /* ─── Error handling ─────────────────────────────────────────────────── */

  describe('error handling', () => {
    it('handles network failure gracefully in feed', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = vi.fn(async () => {
        throw new Error('Network timeout');
      }) as any;

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      const status = service.getPythStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toContain('Network timeout');
      expect(status.running).toBe(true);

      service.stopPythFeed();
    });

    it('handles malformed Pyth response in feed without crashing', async () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const fetchFn = makeFetchFn({ parsed: null });

      const service = new PythOracleService(store, exec, { fetchFn });
      await service.startPythFeed(['SOL'], 60_000);

      const status = service.getPythStatus();
      expect(status.errorCount).toBe(1);
      expect(status.updateCount).toBe(0);

      service.stopPythFeed();
    });

    it('getAllPrices returns empty array when no prices fetched', () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      expect(service.getAllPrices()).toEqual([]);
    });

    it('getPrice returns null for unfetched symbol', () => {
      const state = createDefaultState();
      const store = createMockStore(state);
      const exec = createMockExecutionService(state);
      const service = new PythOracleService(store, exec, { fetchFn: makeFetchFn({}) });

      expect(service.getPrice('SOL')).toBeNull();
    });
  });
});
