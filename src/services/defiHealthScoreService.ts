/**
 * DeFi Health Score Service
 *
 * Aggregates portfolio health, risk exposure, and profit/loss metrics into a
 * single 0–100 score per agent. Components:
 *
 *   - Portfolio diversification score (20%)
 *   - Risk-adjusted returns / Sharpe-based (25%)
 *   - Drawdown severity (25%)
 *   - Position concentration risk (15%)
 *   - Consistency bonus (15%)
 *
 * Overall health grade: A (90+), B (80+), C (70+), D (60+), F (<60)
 * Historical health tracking with snapshots.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthFactor {
  name: string;
  weight: number;
  rawValue: number;
  normalizedScore: number;   // 0–100
  weightedScore: number;     // normalizedScore × weight
  description: string;
}

export interface HealthScore {
  agentId: string;
  score: number;             // 0–100
  grade: HealthGrade;
  calculatedAt: string;
}

export interface HealthScoreBreakdown extends HealthScore {
  factors: HealthFactor[];
  recommendations: string[];
}

export interface HealthScoreSnapshot {
  score: number;
  grade: HealthGrade;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Risk-free annual rate (approximate SOL staking yield). */
const RISK_FREE_RATE = 0.05;

/** Minimum number of return periods to compute Sharpe meaningfully. */
const MIN_PERIODS_FOR_SHARPE = 2;

// ─── Helpers ────────────────────────────────────────────────────────────

function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ─── Service ────────────────────────────────────────────────────────────

export class DefiHealthScoreService {
  /** History: agentId → snapshots */
  private history: Map<string, HealthScoreSnapshot[]> = new Map();
  /** Latest breakdown cache: agentId → HealthScoreBreakdown */
  private cache: Map<string, HealthScoreBreakdown> = new Map();

  constructor(private readonly store: StateStore) {}

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Compute a full health-score breakdown for the given agent.
   */
  calculateHealthScore(agentId: string): HealthScoreBreakdown | null {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return null;

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const positions = Object.values(agent.positions);
    const marketPrices = state.marketPricesUsd;

    // ── Factor 1: Portfolio Diversification (20%) ─────────────────────
    const uniqueSymbols = new Set(positions.map((p) => p.symbol));
    const numAssets = uniqueSymbols.size;

    // Score: 1 asset = 20, 2 = 50, 3 = 70, 4 = 85, 5+ = 100
    let diversificationScore: number;
    if (numAssets === 0) {
      diversificationScore = 50; // no positions → neutral
    } else if (numAssets === 1) {
      diversificationScore = 20;
    } else if (numAssets === 2) {
      diversificationScore = 50;
    } else if (numAssets === 3) {
      diversificationScore = 70;
    } else if (numAssets === 4) {
      diversificationScore = 85;
    } else {
      diversificationScore = 100;
    }

    // ── Factor 2: Risk-Adjusted Returns / Sharpe (25%) ────────────────
    // Compute per-trade returns and derive a Sharpe-like ratio.
    const tradeReturns: number[] = [];
    for (const ex of executions) {
      if (ex.side === 'sell' && ex.grossNotionalUsd > 0) {
        tradeReturns.push(ex.realizedPnlUsd / ex.grossNotionalUsd);
      }
    }

    let sharpeRatio = 0;
    let sharpeScore: number;
    if (tradeReturns.length >= MIN_PERIODS_FOR_SHARPE) {
      const meanReturn = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
      const std = stddev(tradeReturns);
      // Annualize: assume ~250 trading periods / year as approximation
      const annualisedReturn = meanReturn * 250;
      const annualisedStd = std * Math.sqrt(250);
      sharpeRatio = annualisedStd > 0
        ? (annualisedReturn - RISK_FREE_RATE) / annualisedStd
        : (annualisedReturn > 0 ? 3 : 0);

      // Map Sharpe to 0–100: <0 → 0, 0 → 30, 1 → 60, 2 → 80, 3+ → 100
      if (sharpeRatio <= 0) {
        sharpeScore = clamp(30 + sharpeRatio * 30); // negative Sharpe drags below 30
      } else if (sharpeRatio <= 1) {
        sharpeScore = 30 + sharpeRatio * 30;        // 0→30, 1→60
      } else if (sharpeRatio <= 2) {
        sharpeScore = 60 + (sharpeRatio - 1) * 20;  // 1→60, 2→80
      } else {
        sharpeScore = clamp(80 + (sharpeRatio - 2) * 20); // 2→80, 3→100
      }
    } else {
      sharpeScore = 50; // neutral when insufficient data
    }

    // ── Factor 3: Drawdown Severity (25%) ─────────────────────────────
    let maxDrawdownPct = 0;
    if (executions.length > 0) {
      let cumulativePnl = 0;
      let peakEquity = agent.startingCapitalUsd;

      for (const ex of executions) {
        cumulativePnl += ex.realizedPnlUsd;
        const equity = agent.startingCapitalUsd + cumulativePnl;
        if (equity > peakEquity) peakEquity = equity;
        const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }
    // 0% dd → 100, 50% → 50, 100% → 0
    const drawdownScore = clamp((1 - maxDrawdownPct) * 100);

    // ── Factor 4: Position Concentration Risk (15%) ───────────────────
    let concentrationScore: number;
    if (positions.length === 0) {
      concentrationScore = 80; // no positions → mostly safe, slight deduction
    } else {
      // Compute HHI (Herfindahl–Hirschman Index) on position values.
      const positionValues = positions.map((p) => {
        const price = marketPrices[p.symbol] ?? p.avgEntryPriceUsd;
        return Math.abs(p.quantity * price);
      });

      const totalValue = positionValues.reduce((a, b) => a + b, 0);
      if (totalValue === 0) {
        concentrationScore = 80;
      } else {
        const shares = positionValues.map((v) => v / totalValue);
        const hhi = shares.reduce((sum, s) => sum + s * s, 0);
        // hhi for 1 position = 1.0 (most concentrated), for N equal = 1/N
        // min possible hhi for N positions = 1/N
        // Map: hhi=1 → 0, hhi≤0.25 → 100
        concentrationScore = clamp((1 - hhi) * 100 / 0.75);
      }
    }

    // ── Factor 5: Consistency Bonus (15%) ─────────────────────────────
    // Measures how consistent profits are; high variance = low consistency.
    let consistencyScore: number;
    if (tradeReturns.length < 2) {
      consistencyScore = 50; // neutral
    } else {
      const positiveCount = tradeReturns.filter((r) => r > 0).length;
      const winRate = positiveCount / tradeReturns.length;
      // Also factor in return std: lower std = more consistent
      const returnStd = stddev(tradeReturns);
      // winRate component: 60% weight, std component: 40% weight
      const winRateComponent = winRate * 100;
      // std < 0.02 → 100, std > 0.3 → 0
      const stdComponent = clamp((1 - returnStd / 0.3) * 100);
      consistencyScore = clamp(winRateComponent * 0.6 + stdComponent * 0.4);
    }

    // ── Build factors ────────────────────────────────────────────────
    const factors: HealthFactor[] = [
      {
        name: 'diversification',
        weight: 0.20,
        rawValue: numAssets,
        normalizedScore: round2(diversificationScore),
        weightedScore: round2(diversificationScore * 0.20),
        description: `${numAssets} unique asset(s) in portfolio`,
      },
      {
        name: 'riskAdjustedReturns',
        weight: 0.25,
        rawValue: round2(sharpeRatio),
        normalizedScore: round2(sharpeScore),
        weightedScore: round2(sharpeScore * 0.25),
        description: `Sharpe ratio: ${sharpeRatio.toFixed(2)} (${tradeReturns.length} trade returns)`,
      },
      {
        name: 'drawdownSeverity',
        weight: 0.25,
        rawValue: round2(maxDrawdownPct * 100),
        normalizedScore: round2(drawdownScore),
        weightedScore: round2(drawdownScore * 0.25),
        description: `Max drawdown: ${(maxDrawdownPct * 100).toFixed(1)}%`,
      },
      {
        name: 'concentrationRisk',
        weight: 0.15,
        rawValue: round2(positions.length > 0 ? (1 - concentrationScore / 100) : 0),
        normalizedScore: round2(concentrationScore),
        weightedScore: round2(concentrationScore * 0.15),
        description: `Position concentration across ${positions.length} position(s)`,
      },
      {
        name: 'consistency',
        weight: 0.15,
        rawValue: round2(tradeReturns.length > 0
          ? tradeReturns.filter((r) => r > 0).length / tradeReturns.length * 100
          : 0),
        normalizedScore: round2(consistencyScore),
        weightedScore: round2(consistencyScore * 0.15),
        description: tradeReturns.length > 0
          ? `Win rate: ${(tradeReturns.filter((r) => r > 0).length / tradeReturns.length * 100).toFixed(1)}%`
          : 'Insufficient trade data',
      },
    ];

    const totalScore = factors.reduce((sum, f) => sum + f.weightedScore, 0);
    const score = round2(clamp(totalScore));
    const grade = scoreToGrade(score);

    // Generate recommendations
    const recommendations: string[] = [];
    if (diversificationScore < 50) {
      recommendations.push('Consider diversifying across more assets to reduce idiosyncratic risk.');
    }
    if (sharpeScore < 40) {
      recommendations.push('Risk-adjusted returns are below average. Review strategy for better risk/reward.');
    }
    if (drawdownScore < 50) {
      recommendations.push('Drawdown severity is high. Tighten stop-losses or reduce position sizes.');
    }
    if (concentrationScore < 40) {
      recommendations.push('Portfolio is heavily concentrated. Spread exposure across more positions.');
    }
    if (consistencyScore < 40) {
      recommendations.push('Trade consistency is low. Focus on repeatable setups with defined risk.');
    }
    if (score >= 80) {
      recommendations.push('Portfolio health is strong. Maintain current risk management practices.');
    }

    const breakdown: HealthScoreBreakdown = {
      agentId,
      score,
      grade,
      calculatedAt: isoNow(),
      factors,
      recommendations,
    };

    // Cache and record history
    this.cache.set(agentId, breakdown);
    this.recordSnapshot(agentId, score, grade);

    return breakdown;
  }

  /**
   * Get a compact health score (no factor breakdown).
   */
  getHealthScore(agentId: string): HealthScore | null {
    const cached = this.cache.get(agentId);
    if (cached) {
      return {
        agentId: cached.agentId,
        score: cached.score,
        grade: cached.grade,
        calculatedAt: cached.calculatedAt,
      };
    }

    const result = this.calculateHealthScore(agentId);
    if (!result) return null;

    return {
      agentId: result.agentId,
      score: result.score,
      grade: result.grade,
      calculatedAt: result.calculatedAt,
    };
  }

  /**
   * Get detailed health score with factor breakdown.
   */
  getHealthScoreBreakdown(agentId: string): HealthScoreBreakdown | null {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    return this.calculateHealthScore(agentId);
  }

  /**
   * Get historical health score snapshots for an agent.
   */
  getHealthHistory(agentId: string, limit = 50): HealthScoreSnapshot[] {
    const snapshots = this.history.get(agentId) ?? [];
    return snapshots.slice(-limit);
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private recordSnapshot(agentId: string, score: number, grade: HealthGrade): void {
    if (!this.history.has(agentId)) {
      this.history.set(agentId, []);
    }

    this.history.get(agentId)!.push({
      score,
      grade,
      timestamp: isoNow(),
    });

    // Keep last 500 snapshots max
    const snaps = this.history.get(agentId)!;
    if (snaps.length > 500) {
      this.history.set(agentId, snaps.slice(-500));
    }
  }
}
