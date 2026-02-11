/**
 * Price Oracle Service — Pyth-style price feed integration.
 *
 * Fetches real SOL/USDC prices from CoinGecko, caches with configurable TTL,
 * falls back to last known price on failure, and tracks price history.
 * Auto-feeds prices into the state store's market prices on each fetch.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export interface OraclePriceEntry {
  symbol: string;
  priceUsd: number;
  source: string;
  fetchedAt: string;
}

export interface OraclePriceHistoryPoint {
  priceUsd: number;
  fetchedAt: string;
}

export interface OracleStatus {
  running: boolean;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  cacheTtlMs: number;
  fetchCount: number;
  errorCount: number;
  symbols: string[];
}

const MAX_HISTORY = 100;
const DEFAULT_TTL_MS = 30_000;

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

export type FetchFn = (url: string) => Promise<Response>;

export class PriceOracleService {
  private prices: Map<string, OraclePriceEntry> = new Map();
  private history: Map<string, OraclePriceHistoryPoint[]> = new Map();
  private lastFetchAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastError: string | null = null;
  private fetchCount = 0;
  private errorCount = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly cacheTtlMs: number;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly store: StateStore,
    options?: { cacheTtlMs?: number; fetchFn?: FetchFn },
  ) {
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);

    // Seed USDC at $1 — it's a stablecoin
    const now = isoNow();
    this.prices.set('USDC', {
      symbol: 'USDC',
      priceUsd: 1,
      source: 'static',
      fetchedAt: now,
    });
    this.history.set('USDC', [{ priceUsd: 1, fetchedAt: now }]);
  }

  /* ─── Lifecycle ──────────────────────────────────────────────────────── */

  start(): void {
    if (this.running) return;
    this.running = true;
    // Fetch immediately, then on interval
    void this.fetchPrices();
    this.timer = setInterval(() => void this.fetchPrices(), this.cacheTtlMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ─── Public API ─────────────────────────────────────────────────────── */

  getCurrentPrice(symbol: string): OraclePriceEntry | null {
    const upper = symbol.toUpperCase();
    return this.prices.get(upper) ? structuredClone(this.prices.get(upper)!) : null;
  }

  getAllPrices(): OraclePriceEntry[] {
    return Array.from(this.prices.values()).map((p) => structuredClone(p));
  }

  getPriceHistory(symbol: string, limit?: number): OraclePriceHistoryPoint[] {
    const upper = symbol.toUpperCase();
    const hist = this.history.get(upper) ?? [];
    const cap = Math.min(limit ?? MAX_HISTORY, MAX_HISTORY);
    return hist.slice(-cap).map((h) => structuredClone(h));
  }

  getOracleStatus(): OracleStatus {
    return {
      running: this.running,
      lastFetchAt: this.lastFetchAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      cacheTtlMs: this.cacheTtlMs,
      fetchCount: this.fetchCount,
      errorCount: this.errorCount,
      symbols: Array.from(this.prices.keys()),
    };
  }

  /**
   * Manually trigger a price fetch (useful for tests and on-demand refresh).
   */
  async fetchPrices(): Promise<void> {
    const now = isoNow();
    this.lastFetchAt = now;
    this.fetchCount += 1;

    try {
      const response = await this.fetchFn(COINGECKO_URL);
      if (!response.ok) {
        throw new Error(`CoinGecko HTTP ${response.status}`);
      }

      const data = (await response.json()) as { solana?: { usd?: number } };
      const solPrice = data?.solana?.usd;

      if (typeof solPrice !== 'number' || !Number.isFinite(solPrice) || solPrice <= 0) {
        throw new Error('Invalid SOL price from CoinGecko');
      }

      // Update SOL price
      const entry: OraclePriceEntry = {
        symbol: 'SOL',
        priceUsd: solPrice,
        source: 'coingecko',
        fetchedAt: now,
      };
      this.prices.set('SOL', entry);
      this.appendHistory('SOL', solPrice, now);

      this.lastSuccessAt = now;

      // Feed into state store's market prices
      await this.store.transaction((state) => {
        state.marketPricesUsd['SOL'] = solPrice;
        return undefined;
      });

      eventBus.emit('price.updated', {
        symbol: 'SOL',
        priceUsd: solPrice,
        source: 'oracle',
      });
    } catch (err) {
      this.errorCount += 1;
      this.lastErrorAt = now;
      this.lastError = err instanceof Error ? err.message : String(err);

      // Fallback: keep last known price (already in this.prices)
    }
  }

  /* ─── Internals ──────────────────────────────────────────────────────── */

  private appendHistory(symbol: string, priceUsd: number, fetchedAt: string): void {
    if (!this.history.has(symbol)) {
      this.history.set(symbol, []);
    }
    const hist = this.history.get(symbol)!;
    hist.push({ priceUsd, fetchedAt });
    if (hist.length > MAX_HISTORY) {
      hist.splice(0, hist.length - MAX_HISTORY);
    }
  }
}
