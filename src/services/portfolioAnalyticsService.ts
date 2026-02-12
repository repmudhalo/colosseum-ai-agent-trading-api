/**
 * Portfolio Analytics Dashboard service.
 *
 * Advanced portfolio risk and performance metrics:
 * - Value at Risk (VaR) — historical and parametric
 * - Expected Shortfall / Conditional VaR (CVaR)
 * - Beta vs benchmark (SOL)
 * - Alpha (Jensen's alpha)
 * - Information ratio
 * - Rolling Sharpe ratio over configurable windows
 * - Correlation matrix between held assets
 * - Portfolio attribution (per-asset contribution to returns)
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';

// ─── Public result types ───────────────────────────────────────────

export interface VaRResult {
  agentId: string;
  asOf: string;
  confidenceLevel: number;
  historicalVaR: number | null;
  parametricVaR: number | null;
  cvar: number | null;
  observationCount: number;
}

export interface GreeksResult {
  agentId: string;
  asOf: string;
  benchmark: string;
  beta: number | null;
  alpha: number | null;
  informationRatio: number | null;
  observationCount: number;
}

export interface CorrelationResult {
  agentId: string;
  asOf: string;
  assets: string[];
  matrix: number[][];
}

export interface AttributionEntry {
  symbol: string;
  totalPnlUsd: number;
  weight: number;
  contributionPct: number;
}

export interface AttributionResult {
  agentId: string;
  asOf: string;
  totalPnlUsd: number;
  entries: AttributionEntry[];
}

export interface RollingSharpePoint {
  date: string;
  sharpe: number | null;
}

export interface RollingSharpeResult {
  agentId: string;
  asOf: string;
  windowDays: number;
  points: RollingSharpePoint[];
}

// ─── Internal helpers ──────────────────────────────────────────────

const ANNUALIZATION = Math.sqrt(252);

/** Compute mean of an array. */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Compute sample standard deviation (Bessel-corrected). */
function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Sort ascending (non-mutating). */
function sortedAsc(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

/** Compute percentile via linear interpolation (0-100 scale). */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Compute Pearson correlation between two equal-length arrays. */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  if (denom === 0) return 0;
  return cov / denom;
}

// ─── Service ───────────────────────────────────────────────────────

export class PortfolioAnalyticsService {
  constructor(private readonly store: StateStore) {}

  // ── helpers ──────────────────────────────────────────────────────

  private ensureAgent(agentId: string) {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent ${agentId} not found`);
    }
    return { agent, state };
  }

  /**
   * Build a Map<date, pnlUsd> for a given agent from filled executions.
   */
  private buildDailyPnl(agentId: string): Map<string, number> {
    const { state } = this.ensureAgent(agentId);
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const dailyMap = new Map<string, number>();
    for (const ex of executions) {
      const day = ex.createdAt.slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + ex.realizedPnlUsd);
    }
    return dailyMap;
  }

  /**
   * Build per-asset daily PnL maps for all symbols the agent has traded.
   */
  private buildPerAssetDailyPnl(agentId: string): { symbols: string[]; daily: Map<string, Map<string, number>>; allDates: string[] } {
    const { state } = this.ensureAgent(agentId);
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const symbolSet = new Set<string>();
    // date -> symbol -> pnl
    const daily = new Map<string, Map<string, number>>();

    for (const ex of executions) {
      symbolSet.add(ex.symbol);
      const day = ex.createdAt.slice(0, 10);
      if (!daily.has(day)) daily.set(day, new Map());
      const bySymbol = daily.get(day)!;
      bySymbol.set(ex.symbol, (bySymbol.get(ex.symbol) ?? 0) + ex.realizedPnlUsd);
    }

    const symbols = [...symbolSet].sort();
    const allDates = [...daily.keys()].sort();
    return { symbols, daily, allDates };
  }

  /**
   * Get benchmark daily returns (SOL) from market price history.
   */
  private buildBenchmarkDailyReturns(dates: string[]): number[] {
    const state = this.store.snapshot();
    const history = state.marketPriceHistoryUsd['SOL'] ?? [];

    // Build a map date -> price (last entry of the day)
    const priceByDate = new Map<string, number>();
    for (const pt of history) {
      const day = pt.ts.slice(0, 10);
      priceByDate.set(day, pt.priceUsd);
    }

    // For each consecutive pair of dates, compute return
    const returns: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const prevPrice = priceByDate.get(dates[i - 1]);
      const currPrice = priceByDate.get(dates[i]);
      if (prevPrice && currPrice && prevPrice > 0) {
        returns.push((currPrice - prevPrice) / prevPrice);
      } else {
        returns.push(0);
      }
    }
    return returns;
  }

  // ── VaR + CVaR ──────────────────────────────────────────────────

  computeVaR(agentId: string, confidenceLevel = 0.95): VaRResult {
    const dailyPnl = this.buildDailyPnl(agentId);
    const returns = [...dailyPnl.values()];
    const n = returns.length;

    if (n < 2) {
      return {
        agentId,
        asOf: new Date().toISOString(),
        confidenceLevel,
        historicalVaR: null,
        parametricVaR: null,
        cvar: null,
        observationCount: n,
      };
    }

    // Historical VaR: the (1-confidence) percentile of the loss distribution
    const sorted = sortedAsc(returns);
    const historicalVaR = -percentile(sorted, (1 - confidenceLevel) * 100);

    // Parametric VaR (normal assumption): VaR = -( μ + z * σ )
    const mu = mean(returns);
    const sigma = stddev(returns);
    // z-score for common confidence levels
    const zScores: Record<string, number> = { '0.9': 1.2816, '0.95': 1.6449, '0.99': 2.3263 };
    const z = zScores[String(confidenceLevel)] ?? 1.6449;
    const parametricVaR = -(mu - z * sigma);

    // CVaR (Expected Shortfall): average of losses beyond VaR
    const threshold = percentile(sorted, (1 - confidenceLevel) * 100);
    const tail = sorted.filter((r) => r <= threshold);
    const cvar = tail.length > 0 ? -mean(tail) : historicalVaR;

    return {
      agentId,
      asOf: new Date().toISOString(),
      confidenceLevel,
      historicalVaR: round6(historicalVaR),
      parametricVaR: round6(parametricVaR),
      cvar: round6(cvar),
      observationCount: n,
    };
  }

  // ── Beta / Alpha / Information Ratio ────────────────────────────

  computeGreeks(agentId: string): GreeksResult {
    const dailyPnl = this.buildDailyPnl(agentId);
    const dates = [...dailyPnl.keys()].sort();
    const portfolioReturns = dates.map((d) => dailyPnl.get(d) ?? 0);

    if (dates.length < 3) {
      return {
        agentId,
        asOf: new Date().toISOString(),
        benchmark: 'SOL',
        beta: null,
        alpha: null,
        informationRatio: null,
        observationCount: dates.length,
      };
    }

    const benchmarkReturns = this.buildBenchmarkDailyReturns(dates);

    // Align: portfolio returns also needs to be deltas (difference from one day to next)
    // Actually, our portfolio "returns" are already daily P&L in USD. For beta/alpha
    // we need actual return ratios. Since we don't have a "portfolio value" time series,
    // we'll use the daily P&L directly divided by starting capital as a return proxy.
    const { agent } = this.ensureAgent(agentId);
    const capital = agent.startingCapitalUsd || 10_000;

    // Convert PnL to return fractions starting from day index 1
    // benchmarkReturns already has length = dates.length - 1
    const pReturns: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      pReturns.push((dailyPnl.get(dates[i]) ?? 0) / capital);
    }

    const n = Math.min(pReturns.length, benchmarkReturns.length);
    if (n < 2) {
      return { agentId, asOf: new Date().toISOString(), benchmark: 'SOL', beta: null, alpha: null, informationRatio: null, observationCount: n };
    }

    const pr = pReturns.slice(0, n);
    const br = benchmarkReturns.slice(0, n);

    // Beta = Cov(rp, rb) / Var(rb)
    const mPr = mean(pr);
    const mBr = mean(br);
    let cov = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
      cov += (pr[i] - mPr) * (br[i] - mBr);
      varB += (br[i] - mBr) ** 2;
    }
    cov /= n - 1;
    varB /= n - 1;

    const beta = varB > 0 ? cov / varB : null;

    // Jensen's alpha (annualized): α = (Rp - Rf) - β * (Rb - Rf), Rf ≈ 0
    const alpha = beta !== null
      ? (mPr - beta * mBr) * 252  // annualized
      : null;

    // Information Ratio = (Rp - Rb) / TrackingError
    const activeReturns = pr.map((r, i) => r - br[i]);
    const te = stddev(activeReturns);
    const informationRatio = te > 0
      ? (mean(activeReturns) / te) * ANNUALIZATION
      : null;

    return {
      agentId,
      asOf: new Date().toISOString(),
      benchmark: 'SOL',
      beta: beta !== null ? round6(beta) : null,
      alpha: alpha !== null ? round6(alpha) : null,
      informationRatio: informationRatio !== null ? round6(informationRatio) : null,
      observationCount: n,
    };
  }

  // ── Correlation Matrix ──────────────────────────────────────────

  computeCorrelation(agentId: string): CorrelationResult {
    const { symbols, daily, allDates } = this.buildPerAssetDailyPnl(agentId);

    if (allDates.length < 2) {
      return {
        agentId,
        asOf: new Date().toISOString(),
        assets: symbols,
        matrix: symbols.map((_, i) => symbols.map((_, j) => (i === j ? 1 : 0))),
      };
    }

    // Build return series per symbol (aligned by date)
    const series: Record<string, number[]> = {};
    for (const sym of symbols) series[sym] = [];

    for (const date of allDates) {
      const bySymbol = daily.get(date);
      for (const sym of symbols) {
        series[sym].push(bySymbol?.get(sym) ?? 0);
      }
    }

    const matrix: number[][] = [];
    for (const s1 of symbols) {
      const row: number[] = [];
      for (const s2 of symbols) {
        row.push(round6(pearson(series[s1], series[s2])));
      }
      matrix.push(row);
    }

    return {
      agentId,
      asOf: new Date().toISOString(),
      assets: symbols,
      matrix,
    };
  }

  // ── Attribution ─────────────────────────────────────────────────

  computeAttribution(agentId: string): AttributionResult {
    const { state } = this.ensureAgent(agentId);
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled');

    const bySymbol = new Map<string, number>();
    let totalPnl = 0;

    for (const ex of executions) {
      bySymbol.set(ex.symbol, (bySymbol.get(ex.symbol) ?? 0) + ex.realizedPnlUsd);
      totalPnl += ex.realizedPnlUsd;
    }

    const entries: AttributionEntry[] = [...bySymbol.entries()]
      .map(([symbol, pnl]) => {
        const absTotalPnl = Math.abs(totalPnl);
        return {
          symbol,
          totalPnlUsd: round6(pnl),
          weight: absTotalPnl > 0 ? round6(pnl / absTotalPnl) : 0,
          contributionPct: absTotalPnl > 0 ? round6((pnl / absTotalPnl) * 100) : 0,
        };
      })
      .sort((a, b) => Math.abs(b.totalPnlUsd) - Math.abs(a.totalPnlUsd));

    return {
      agentId,
      asOf: new Date().toISOString(),
      totalPnlUsd: round6(totalPnl),
      entries,
    };
  }

  // ── Rolling Sharpe ──────────────────────────────────────────────

  computeRollingSharpe(agentId: string, windowDays = 30): RollingSharpeResult {
    const dailyPnl = this.buildDailyPnl(agentId);
    const dates = [...dailyPnl.keys()].sort();
    const returns = dates.map((d) => dailyPnl.get(d) ?? 0);

    const points: RollingSharpePoint[] = [];

    for (let i = windowDays - 1; i < dates.length; i++) {
      const window = returns.slice(i - windowDays + 1, i + 1);
      const m = mean(window);
      const s = stddev(window);
      const sharpe = s > 0 ? round6((m / s) * ANNUALIZATION) : null;
      points.push({ date: dates[i], sharpe });
    }

    return {
      agentId,
      asOf: new Date().toISOString(),
      windowDays,
      points,
    };
  }
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}
