/**
 * Chart Capture Service — Automated TradingView chart screenshots.
 *
 * Uses Puppeteer to navigate to DexScreener's TradingView chart
 * for a given Solana token, selects the 5-second candle timeframe,
 * and captures a screenshot of the chart.
 *
 * Screenshots are stored in data/charts/ with metadata JSON.
 * Over time this builds a visual library of chart patterns
 * that can be used for visual pattern recognition.
 *
 * Captures:
 *   - On buy (what did the chart look like at entry?)
 *   - On auto-exit (what did it look like at TP/SL/trailing?)
 *   - On demand (manual capture via API)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { AppConfig } from '../config.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Metadata stored alongside each chart screenshot. */
export interface ChartCapture {
  id: string;
  mintAddress: string;
  /** Why was this chart captured? */
  trigger: 'buy' | 'sell' | 'auto_exit_tp' | 'auto_exit_sl' | 'auto_exit_trailing' | 're_entry' | 'manual' | 'reference';
  /** Price at the moment of capture. */
  priceUsd: number | null;
  /** Entry price for the position (if known). */
  entryPriceUsd: number | null;
  /** % change from entry at time of capture. */
  changePct: number | null;
  /** Timeframe shown on the chart. */
  timeframe: string;
  /** Tag/note from the user or bot. */
  tag: string | null;
  /** Whether this is a "good chart" reference image. */
  isReference: boolean;
  /** Filename of the PNG (relative to charts dir). */
  filename: string;
  /** Full DexScreener URL used. */
  sourceUrl: string;
  capturedAt: string;
}

/** Summary returned by the list endpoint. */
export interface ChartLibrary {
  totalCaptures: number;
  referenceCharts: number;
  tradeCharts: number;
  captures: ChartCapture[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Primary chart source: GeckoTerminal (more headless-friendly). */
const GECKOTERMINAL_URL = 'https://www.geckoterminal.com/solana/tokens';

/** Fallback chart source: DexScreener. */
const DEXSCREENER_URL = 'https://dexscreener.com/solana';

/** Default timeframe: 1 second (DexScreener's lowest option). */
const DEFAULT_TIMEFRAME = '1s';

/** Viewport for the headless browser (wide to get a good chart). */
const VIEWPORT = { width: 1400, height: 900 };

/** How long to wait for page navigation (ms). */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** Max concurrent captures (prevent resource exhaustion). */
const MAX_CONCURRENT = 2;

// ─── Service ─────────────────────────────────────────────────────────────────

export class ChartCaptureService {
  private readonly chartsDir: string;
  private readonly metadataPath: string;
  private captures: ChartCapture[] = [];
  private browser: Browser | null = null;
  private activeCaptureCount = 0;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly config: AppConfig) {
    this.chartsDir = path.resolve(config.paths.dataDir, 'charts');
    this.metadataPath = path.resolve(this.chartsDir, 'metadata.json');
  }

  // ─── Public: Init / Shutdown ──────────────────────────────────────────

  /** Load stored metadata and start listening to snipe events. */
  async init(): Promise<void> {
    // Ensure charts directory exists.
    await fs.mkdir(this.chartsDir, { recursive: true });

    // Load existing metadata.
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf-8');
      this.captures = JSON.parse(raw) as ChartCapture[];
    } catch {
      this.captures = [];
    }

    // Listen to snipe events for auto-capture.
    const unsub1 = eventBus.on('snipe.trade', (_event, data) => {
      const d = data as { mintAddress: string; side: string; entryPriceUsd: number | null; currentPriceUsd: number | null; tag: string | null };
      const trigger = d.side === 'buy' ? 'buy' : 'sell';
      this.captureInBackground(d.mintAddress, trigger, d.currentPriceUsd, d.entryPriceUsd, d.tag);
    });

    const unsub2 = eventBus.on('snipe.auto_exit', (_event, data) => {
      const d = data as { mintAddress: string; reason: string; isTakeProfit: boolean };
      let trigger: ChartCapture['trigger'] = 'auto_exit_sl';
      if (d.isTakeProfit) trigger = 'auto_exit_tp';
      if (d.reason.includes('trailing_stop')) trigger = 'auto_exit_trailing';
      this.captureInBackground(d.mintAddress, trigger, null, null, d.reason);
    });

    const unsub3 = eventBus.on('snipe.re_entry', (_event, data) => {
      const d = data as { mintAddress: string };
      this.captureInBackground(d.mintAddress, 're_entry', null, null, null);
    });

    this.unsubscribers.push(unsub1, unsub2, unsub3);
  }

  /** Close the browser and stop listening. */
  async shutdown(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  // ─── Public: Manual Capture ────────────────────────────────────────────

  /** Capture a chart screenshot on demand. Returns the capture metadata. */
  async capture(
    mintAddress: string,
    trigger: ChartCapture['trigger'] = 'manual',
    priceUsd: number | null = null,
    entryPriceUsd: number | null = null,
    tag: string | null = null,
  ): Promise<ChartCapture | null> {
    return this.doCapture(mintAddress, trigger, priceUsd, entryPriceUsd, tag);
  }

  // ─── Public: Reference Charts ─────────────────────────────────────────

  /**
   * Save an uploaded image as a reference ("good looking") chart.
   * The bot or user uploads a PNG buffer with metadata.
   */
  async saveReference(
    mintAddress: string,
    imageBuffer: Buffer,
    tag: string | null = null,
  ): Promise<ChartCapture> {
    const id = this.generateId();
    const filename = `ref_${mintAddress.slice(0, 8)}_${id}.png`;
    const filepath = path.join(this.chartsDir, filename);

    await fs.writeFile(filepath, imageBuffer);

    const capture: ChartCapture = {
      id,
      mintAddress,
      trigger: 'reference',
      priceUsd: null,
      entryPriceUsd: null,
      changePct: null,
      timeframe: 'unknown',
      tag,
      isReference: true,
      filename,
      sourceUrl: 'uploaded',
      capturedAt: new Date().toISOString(),
    };

    this.captures.push(capture);
    await this.persistMetadata();
    return capture;
  }

  // ─── Public: Library Access ────────────────────────────────────────────

  /** Get all captures, optionally filtered by mint or trigger. */
  getLibrary(mintAddress?: string, trigger?: string, limit = 50): ChartLibrary {
    let filtered = this.captures;
    if (mintAddress) filtered = filtered.filter((c) => c.mintAddress === mintAddress);
    if (trigger) filtered = filtered.filter((c) => c.trigger === trigger);

    const referenceCharts = this.captures.filter((c) => c.isReference).length;
    const tradeCharts = this.captures.filter((c) => !c.isReference).length;

    return {
      totalCaptures: this.captures.length,
      referenceCharts,
      tradeCharts,
      captures: filtered.slice(-limit).reverse(), // Newest first.
    };
  }

  /** Get the file path for a capture image (for serving via API). */
  getImagePath(filename: string): string {
    return path.join(this.chartsDir, filename);
  }

  // ─── Private: Core Capture Logic ───────────────────────────────────────

  /** Fire-and-forget capture (for event-driven auto-capture). */
  private captureInBackground(
    mintAddress: string,
    trigger: ChartCapture['trigger'],
    priceUsd: number | null,
    entryPriceUsd: number | null,
    tag: string | null,
  ): void {
    // Don't queue too many concurrent captures.
    if (this.activeCaptureCount >= MAX_CONCURRENT) return;

    this.doCapture(mintAddress, trigger, priceUsd, entryPriceUsd, tag).catch(() => {
      // Capture failures are non-fatal.
    });
  }

  /**
   * Navigate to DexScreener, select 5s timeframe, and screenshot the chart.
   */
  private async doCapture(
    mintAddress: string,
    trigger: ChartCapture['trigger'],
    priceUsd: number | null,
    entryPriceUsd: number | null,
    tag: string | null,
  ): Promise<ChartCapture | null> {
    this.activeCaptureCount++;
    let page: Page | null = null;

    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      await page.setViewport(VIEWPORT);

      // Set a real user-agent so DexScreener serves chart data.
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      // GeckoTerminal renders TradingView charts well in headless mode.
      // Use ?resolution=1 for 1-minute candles (lowest reliable via URL param).
      // Resolution values: 1, 5, 15, 60, 240, 1D, etc.
      const url = `${GECKOTERMINAL_URL}/${mintAddress}?resolution=1`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });

      // Wait for the chart canvas to appear in the DOM.
      await page.waitForSelector('canvas, .tv-lightweight-charts, iframe', { timeout: 15_000 }).catch(() => {});

      // Give the chart time to render candle data via WebSocket.
      await this.sleep(10_000);

      // Dismiss any popups/banners that might overlay the chart.
      await this.dismissOverlays(page);

      // Screenshot the full page (chart is usually the main content).
      const id = this.generateId();
      const filename = `${trigger}_${mintAddress.slice(0, 8)}_${id}.png`;
      const filepath = path.join(this.chartsDir, filename);

      await page.screenshot({ path: filepath, fullPage: false });

      // Calculate % change if we have both prices.
      let changePct: number | null = null;
      if (priceUsd && entryPriceUsd && entryPriceUsd > 0) {
        changePct = Number((((priceUsd - entryPriceUsd) / entryPriceUsd) * 100).toFixed(2));
      }

      const capture: ChartCapture = {
        id,
        mintAddress,
        trigger,
        priceUsd,
        entryPriceUsd,
        changePct,
        timeframe: DEFAULT_TIMEFRAME,
        tag,
        isReference: false,
        filename,
        sourceUrl: url,
        capturedAt: new Date().toISOString(),
      };

      this.captures.push(capture);
      await this.persistMetadata();
      return capture;

    } catch (err) {
      // Chart capture is best-effort. Never crash the trading service.
      // Log the error so we can debug if needed.
      console.error('[chart-capture] Failed:', (err as Error).message ?? err);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
      this.activeCaptureCount--;
    }
  }

  /**
   * Try to select the 5-second timeframe on DexScreener's chart.
   * DexScreener's timeframe buttons are in the chart toolbar.
   * We try multiple selector strategies.
   */
  private async selectTimeframe(page: Page): Promise<void> {
    try {
      // GeckoTerminal & DexScreener show timeframe buttons in a toolbar.
      // We want the lowest available: 1s > 5s > 1m > 5m.
      // Use multiple strategies to find and click the right button.

      // Strategy 1: Use XPath-style text matching via evaluate.
      const clicked = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as unknown as Record<string, any>)['document'];

        // Get ALL clickable elements in the page.
        const allEls = doc.querySelectorAll('button, a, span, div[role="button"], [class*="timeframe"], [class*="resolution"], [class*="interval"]');

        // Priority: smallest timeframe first.
        const priorities = ['1s', '5s', '1m', '5m'];

        for (const target of priorities) {
          for (const el of allEls) {
            const text = (el as any).textContent?.trim();
            // Exact match or match within a small element (avoid matching "15m" when looking for "5m").
            if (text === target && (el as any).textContent?.length <= 4) {
              (el as any).click();
              return target;
            }
          }
        }
        return null;
      });

      if (clicked) return;

      // Strategy 2: Try keyboard shortcut. TradingView charts support
      // keyboard shortcuts for timeframe changes (e.g. type "1" for 1min).
      // Focus the chart area first then type.
      await page.click('canvas').catch(() => {});
      await this.sleep(300);
      // TradingView: typing a number changes the interval.
      // "1" = 1min, but this varies by implementation.
    } catch {
      // Timeframe selection is best-effort. The default timeframe is still useful.
    }
  }

  /** Dismiss cookie banners, popups, or overlays. */
  private async dismissOverlays(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const doc = (globalThis as unknown as Record<string, any>)['document'];
        const selectors = [
          '[class*="cookie"] button',
          '[class*="banner"] button[class*="close"]',
          '[class*="modal"] button[class*="close"]',
          '[class*="popup"] button[class*="close"]',
          'button[aria-label="Close"]',
          'button[aria-label="close"]',
        ];
        for (const sel of selectors) {
          const el = doc.querySelector(sel);
          if (el) (el as any).click();
        }
      });
    } catch {
      // Non-fatal.
    }
  }

  // ─── Private: Browser Management ──────────────────────────────────────

  /** Get or launch the shared headless browser instance. */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (e.g. in Docker).
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    // Use Chrome's new headless mode — more like a real browser,
    // better compatibility with WebSocket-dependent chart widgets.
    this.browser = await puppeteer.launch({
      headless: 'shell',
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-web-security',           // Allow cross-origin WebSocket
        '--allow-running-insecure-content',  // Allow mixed content
      ],
    });

    return this.browser;
  }

  // ─── Private: Helpers ─────────────────────────────────────────────────

  private async persistMetadata(): Promise<void> {
    try {
      await fs.writeFile(this.metadataPath, JSON.stringify(this.captures, null, 2));
    } catch {
      // Best-effort.
    }
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
