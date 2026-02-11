/**
 * Pyth Network Oracle Service — Real-time price feeds from Pyth's Hermes API.
 *
 * Fetches prices from Pyth Network (Solana's native oracle), supports
 * auto-feeding into the trading pipeline, and emits events on updates.
 * No API key required.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { ExecutionService } from './executionService.js';
import { isoNow } from '../utils/time.js';

/* ─── Pyth Price IDs ───────────────────────────────────────────────────── */

const PYTH_PRICE_IDS: Record<string, string> = {
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

const PYTH_HERMES_BASE = 'https://hermes.pyth.network/v2';

/* ─── Types ────────────────────────────────────────────────────────────── */

export interface PythPriceEntry {
  symbol: string;
  priceUsd: number;
  confidence: number;
  expo: number;
  publishTime: string;
  source: 'pyth';
  fetchedAt: string;
}

export interface PythFeedStatus {
  running: boolean;
  symbols: string[];
  intervalMs: number;
  lastUpdateAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  updateCount: number;
  errorCount: number;
  prices: Record<string, PythPriceEntry>;
}

export type FetchFn = (url: string) => Promise<Response>;

/* ─── Pyth Hermes response shapes ─────────────────────────────────────── */

interface PythParsedPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface PythParsedEntry {
  id: string;
  price: PythParsedPrice;
  ema_price: PythParsedPrice;
}

interface PythHermesResponse {
  parsed: PythParsedEntry[];
}

/* ─── Service ──────────────────────────────────────────────────────────── */

export class PythOracleService {
  private prices: Map<string, PythPriceEntry> = new Map();
  private running = false;
  private feedSymbols: string[] = [];
  private feedIntervalMs = 30_000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastError: string | null = null;
  private updateCount = 0;
  private errorCount = 0;

  private readonly fetchFn: FetchFn;

  constructor(
    private readonly store: StateStore,
    private readonly executionService: ExecutionService,
    options?: { fetchFn?: FetchFn },
  ) {
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /* ─── Symbol mapping ─────────────────────────────────────────────────── */

  static getSupportedSymbols(): string[] {
    return Object.keys(PYTH_PRICE_IDS);
  }

  static getPriceId(symbol: string): string | undefined {
    return PYTH_PRICE_IDS[symbol.toUpperCase()];
  }

  /* ─── Single price fetch ─────────────────────────────────────────────── */

  async fetchPythPrice(symbol: string): Promise<PythPriceEntry> {
    const upper = symbol.toUpperCase();
    const priceId = PYTH_PRICE_IDS[upper];
    if (!priceId) {
      throw new Error(`Unsupported Pyth symbol: ${symbol}. Supported: ${Object.keys(PYTH_PRICE_IDS).join(', ')}`);
    }

    const url = `${PYTH_HERMES_BASE}/updates/price/latest?ids[]=${priceId}`;
    const now = isoNow();

    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Pyth Hermes HTTP ${response.status}`);
    }

    const data = (await response.json()) as PythHermesResponse;
    if (!data.parsed || !Array.isArray(data.parsed) || data.parsed.length === 0) {
      throw new Error('Invalid Pyth response: no parsed data');
    }

    const parsed = data.parsed[0];
    if (!parsed.price || typeof parsed.price.price !== 'string' || typeof parsed.price.expo !== 'number') {
      throw new Error('Invalid Pyth response: malformed price data');
    }

    const rawPrice = Number(parsed.price.price);
    const expo = parsed.price.expo;
    const priceUsd = rawPrice * Math.pow(10, expo);
    const confidence = Number(parsed.price.conf) * Math.pow(10, expo);

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Invalid computed price for ${upper}: ${priceUsd}`);
    }

    const entry: PythPriceEntry = {
      symbol: upper,
      priceUsd,
      confidence,
      expo,
      publishTime: new Date(parsed.price.publish_time * 1000).toISOString(),
      source: 'pyth',
      fetchedAt: now,
    };

    this.prices.set(upper, entry);
    return entry;
  }

  /* ─── Multi-symbol fetch (used by feed) ──────────────────────────────── */

  async fetchMultiplePythPrices(symbols: string[]): Promise<PythPriceEntry[]> {
    const validSymbols = symbols
      .map((s) => s.toUpperCase())
      .filter((s) => PYTH_PRICE_IDS[s]);

    if (validSymbols.length === 0) {
      throw new Error('No valid Pyth symbols provided');
    }

    const queryParams = validSymbols
      .map((s) => `ids[]=${PYTH_PRICE_IDS[s]}`)
      .join('&');
    const url = `${PYTH_HERMES_BASE}/updates/price/latest?${queryParams}`;
    const now = isoNow();

    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Pyth Hermes HTTP ${response.status}`);
    }

    const data = (await response.json()) as PythHermesResponse;
    if (!data.parsed || !Array.isArray(data.parsed)) {
      throw new Error('Invalid Pyth response: no parsed data');
    }

    // Build a reverse map: priceId → symbol
    const idToSymbol: Record<string, string> = {};
    for (const sym of validSymbols) {
      const id = PYTH_PRICE_IDS[sym].replace(/^0x/, '');
      idToSymbol[id] = sym;
    }

    const entries: PythPriceEntry[] = [];

    for (const parsed of data.parsed) {
      const normalizedId = parsed.id.replace(/^0x/, '');
      const sym = idToSymbol[normalizedId];
      if (!sym) continue;

      const rawPrice = Number(parsed.price.price);
      const expo = parsed.price.expo;
      const priceUsd = rawPrice * Math.pow(10, expo);
      const confidence = Number(parsed.price.conf) * Math.pow(10, expo);

      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

      const entry: PythPriceEntry = {
        symbol: sym,
        priceUsd,
        confidence,
        expo,
        publishTime: new Date(parsed.price.publish_time * 1000).toISOString(),
        source: 'pyth',
        fetchedAt: now,
      };

      this.prices.set(sym, entry);
      entries.push(entry);
    }

    return entries;
  }

  /* ─── Auto-feed lifecycle ────────────────────────────────────────────── */

  async startPythFeed(symbols: string[], intervalMs: number = 30_000): Promise<void> {
    if (this.running) {
      this.stopPythFeed();
    }

    const validSymbols = symbols
      .map((s) => s.toUpperCase())
      .filter((s) => PYTH_PRICE_IDS[s]);

    if (validSymbols.length === 0) {
      throw new Error('No valid Pyth symbols provided');
    }

    this.running = true;
    this.feedSymbols = validSymbols;
    this.feedIntervalMs = intervalMs;

    // Fetch immediately
    await this.feedTick();

    // Then on interval
    this.timer = setInterval(() => void this.feedTick(), intervalMs);
  }

  stopPythFeed(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.feedSymbols = [];
  }

  /* ─── Status ─────────────────────────────────────────────────────────── */

  getPythStatus(): PythFeedStatus {
    const pricesObj: Record<string, PythPriceEntry> = {};
    for (const [sym, entry] of this.prices) {
      pricesObj[sym] = structuredClone(entry);
    }

    return {
      running: this.running,
      symbols: [...this.feedSymbols],
      intervalMs: this.feedIntervalMs,
      lastUpdateAt: this.lastUpdateAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      updateCount: this.updateCount,
      errorCount: this.errorCount,
      prices: pricesObj,
    };
  }

  /* ─── Public getter ──────────────────────────────────────────────────── */

  getAllPrices(): PythPriceEntry[] {
    return Array.from(this.prices.values()).map((p) => structuredClone(p));
  }

  getPrice(symbol: string): PythPriceEntry | null {
    const entry = this.prices.get(symbol.toUpperCase());
    return entry ? structuredClone(entry) : null;
  }

  /* ─── Internals ──────────────────────────────────────────────────────── */

  private async feedTick(): Promise<void> {
    const now = isoNow();
    try {
      const entries = await this.fetchMultiplePythPrices(this.feedSymbols);

      for (const entry of entries) {
        // Feed into the execution service / state store
        await this.executionService.setMarketPrice(entry.symbol, entry.priceUsd);

        // Emit event
        eventBus.emit('price.updated', {
          symbol: entry.symbol,
          priceUsd: entry.priceUsd,
          confidence: entry.confidence,
          source: 'pyth',
        });
      }

      this.lastUpdateAt = now;
      this.updateCount += 1;
    } catch (err) {
      this.errorCount += 1;
      this.lastErrorAt = now;
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
