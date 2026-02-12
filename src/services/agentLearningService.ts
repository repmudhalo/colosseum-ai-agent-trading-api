/**
 * Agent Learning & Memory Service.
 *
 * Agents that learn from past trades and adapt their behavior.
 *
 * Features:
 * - Trade pattern recognition (what worked, what didn't)
 * - Market regime detection (trending / ranging / volatile)
 * - Adaptive parameter tuning based on recent performance
 * - Knowledge base that persists learnings
 * - Confidence scoring for trade signals based on historical accuracy
 * - Learning metrics dashboard
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';
import { ExecutionRecord, Side, StrategyId } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MarketRegime = 'trending-up' | 'trending-down' | 'ranging' | 'volatile' | 'unknown';

export interface TradePattern {
  symbol: string;
  side: Side;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  tags: string[];
}

export interface PatternSummary {
  agentId: string;
  totalPatternsAnalyzed: number;
  patterns: TradePattern[];
  topWinningPatterns: TradePattern[];
  topLosingPatterns: TradePattern[];
  overallWinRate: number;
  timestamp: string;
}

export interface RegimeDetection {
  symbol: string;
  regime: MarketRegime;
  confidence: number;
  volatility: number;
  trendStrength: number;
  avgReturn: number;
  priceRange: { high: number; low: number; current: number };
  dataPoints: number;
  timestamp: string;
}

export interface AdaptiveParameters {
  agentId: string;
  previousParams: Record<string, number>;
  suggestedParams: Record<string, number>;
  adjustments: ParameterAdjustment[];
  appliedAt: string;
}

export interface ParameterAdjustment {
  parameter: string;
  previousValue: number;
  newValue: number;
  reason: string;
  confidenceLevel: number;
}

export interface KnowledgeEntry {
  id: string;
  agentId: string;
  category: 'pattern' | 'regime' | 'adaptation' | 'insight';
  key: string;
  value: unknown;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
}

export interface ConfidenceScore {
  symbol: string;
  side: Side;
  confidence: number;
  historicalAccuracy: number;
  sampleSize: number;
  recentTrend: 'improving' | 'declining' | 'stable';
  regimeAlignment: number;
  factors: ConfidenceFactor[];
  timestamp: string;
}

export interface ConfidenceFactor {
  name: string;
  weight: number;
  score: number;
  contribution: number;
}

export interface LearningMetrics {
  agentId: string;
  totalTradesAnalyzed: number;
  totalPatternsLearned: number;
  knowledgeBaseSize: number;
  adaptationCount: number;
  avgConfidence: number;
  learningRate: number;
  recentAccuracy: number;
  regimesDetected: Record<MarketRegime, number>;
  improvementOverBaseline: number;
  lastLearningCycleAt: string | null;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VOLATILITY_THRESHOLD_HIGH = 0.03;
const VOLATILITY_THRESHOLD_LOW = 0.01;
const TREND_THRESHOLD = 0.015;
const MIN_TRADES_FOR_PATTERN = 2;
const RECENT_WINDOW = 20;
const MAX_KNOWLEDGE_ENTRIES = 1000;

// Confidence factor weights
const WEIGHT_HISTORICAL_ACCURACY = 0.30;
const WEIGHT_SAMPLE_SIZE = 0.15;
const WEIGHT_RECENT_TREND = 0.20;
const WEIGHT_REGIME_ALIGNMENT = 0.20;
const WEIGHT_PROFIT_FACTOR = 0.15;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function generateId(): string {
  return `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AgentLearningService {
  /** agentId → knowledge entries */
  private knowledgeBase: Map<string, KnowledgeEntry[]> = new Map();
  /** agentId → adaptation history */
  private adaptationHistory: Map<string, AdaptiveParameters[]> = new Map();
  /** agentId → last learning cycle timestamp */
  private lastLearningCycle: Map<string, string> = new Map();

  constructor(private readonly store: StateStore) {}

  // ─── Trade Pattern Recognition ────────────────────────────────────────

  /**
   * Analyze an agent's trade history to identify winning and losing patterns.
   * Groups trades by symbol+side and computes stats for each pattern.
   */
  analyzePatterns(agentId: string): PatternSummary {
    const state = this.store.snapshot();
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled');

    const patternMap = new Map<string, ExecutionRecord[]>();

    for (const ex of executions) {
      const key = `${ex.symbol}:${ex.side}`;
      if (!patternMap.has(key)) patternMap.set(key, []);
      patternMap.get(key)!.push(ex);
    }

    const patterns: TradePattern[] = [];

    for (const [key, trades] of patternMap) {
      if (trades.length < MIN_TRADES_FOR_PATTERN) continue;

      const [symbol, side] = key.split(':') as [string, Side];
      const pnls = trades.map((t) => t.realizedPnlUsd);
      const wins = pnls.filter((p) => p > 0);
      const losses = pnls.filter((p) => p < 0);

      const totalWinPnl = wins.reduce((s, p) => s + p, 0);
      const totalLossPnl = Math.abs(losses.reduce((s, p) => s + p, 0));

      const winRate = trades.length > 0 ? wins.length / trades.length : 0;
      const avgWinPnl = wins.length > 0 ? totalWinPnl / wins.length : 0;
      const avgLossPnl = losses.length > 0 ? totalLossPnl / losses.length : 0;
      const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : (totalWinPnl > 0 ? Infinity : 0);
      const expectancy = (winRate * avgWinPnl) - ((1 - winRate) * avgLossPnl);

      const tags: string[] = [];
      if (winRate > 0.7) tags.push('high-win-rate');
      if (winRate < 0.3) tags.push('low-win-rate');
      if (profitFactor > 2) tags.push('profitable');
      if (profitFactor < 0.5 && profitFactor > 0) tags.push('unprofitable');
      if (trades.length >= 10) tags.push('well-tested');
      if (expectancy > 0) tags.push('positive-expectancy');
      if (expectancy < 0) tags.push('negative-expectancy');

      patterns.push({
        symbol,
        side,
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: Number(winRate.toFixed(4)),
        avgWinPnl: Number(avgWinPnl.toFixed(4)),
        avgLossPnl: Number(avgLossPnl.toFixed(4)),
        profitFactor: profitFactor === Infinity ? 999 : Number(profitFactor.toFixed(4)),
        expectancy: Number(expectancy.toFixed(4)),
        bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
        worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
        tags,
      });
    }

    // Sort by expectancy descending
    patterns.sort((a, b) => b.expectancy - a.expectancy);

    const topWinning = patterns.filter((p) => p.expectancy > 0).slice(0, 5);
    const topLosing = patterns.filter((p) => p.expectancy < 0).slice(-5).reverse();

    const totalTrades = executions.length;
    const totalWins = executions.filter((ex) => ex.realizedPnlUsd > 0).length;
    const overallWinRate = totalTrades > 0 ? Number((totalWins / totalTrades).toFixed(4)) : 0;

    // Store patterns as knowledge
    this.upsertKnowledge(agentId, 'pattern', 'trade-patterns', {
      patternCount: patterns.length,
      overallWinRate,
    }, overallWinRate);

    return {
      agentId,
      totalPatternsAnalyzed: patterns.length,
      patterns,
      topWinningPatterns: topWinning,
      topLosingPatterns: topLosing,
      overallWinRate,
      timestamp: isoNow(),
    };
  }

  // ─── Market Regime Detection ──────────────────────────────────────────

  /**
   * Detect current market regime for a symbol based on price history.
   *
   * Regimes:
   * - trending-up: consistent upward price movement
   * - trending-down: consistent downward price movement
   * - ranging: price oscillating within a band
   * - volatile: large price swings with no clear direction
   * - unknown: insufficient data
   */
  detectRegime(symbol: string): RegimeDetection {
    const upper = symbol.toUpperCase();
    const state = this.store.snapshot();
    const priceHistory = state.marketPriceHistoryUsd[upper];

    if (!priceHistory || priceHistory.length < 3) {
      return {
        symbol: upper,
        regime: 'unknown',
        confidence: 0,
        volatility: 0,
        trendStrength: 0,
        avgReturn: 0,
        priceRange: { high: 0, low: 0, current: 0 },
        dataPoints: priceHistory?.length ?? 0,
        timestamp: isoNow(),
      };
    }

    const prices = priceHistory.map((p) => p.priceUsd);
    const recent = prices.slice(-RECENT_WINDOW);

    // Compute returns
    const returns: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i - 1] > 0) {
        returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
      }
    }

    if (returns.length === 0) {
      return {
        symbol: upper,
        regime: 'unknown',
        confidence: 0,
        volatility: 0,
        trendStrength: 0,
        avgReturn: 0,
        priceRange: { high: Math.max(...recent), low: Math.min(...recent), current: recent[recent.length - 1] },
        dataPoints: recent.length,
        timestamp: isoNow(),
      };
    }

    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const volatility = computeStdDev(returns);

    // Trend strength: ratio of cumulative return to volatility
    const cumulativeReturn = (recent[recent.length - 1] - recent[0]) / recent[0];
    const trendStrength = volatility > 0 ? Math.abs(cumulativeReturn) / volatility : 0;

    // Count direction consistency
    const upMoves = returns.filter((r) => r > 0).length;
    const downMoves = returns.filter((r) => r < 0).length;
    const totalMoves = upMoves + downMoves;
    const directionConsistency = totalMoves > 0 ? Math.abs(upMoves - downMoves) / totalMoves : 0;

    // Determine regime
    let regime: MarketRegime;
    let confidence: number;

    if (volatility > VOLATILITY_THRESHOLD_HIGH && directionConsistency < 0.3) {
      regime = 'volatile';
      confidence = clamp(volatility / VOLATILITY_THRESHOLD_HIGH * 0.5 + 0.3, 0, 1);
    } else if (Math.abs(avgReturn) > TREND_THRESHOLD && directionConsistency > 0.4) {
      regime = avgReturn > 0 ? 'trending-up' : 'trending-down';
      confidence = clamp(directionConsistency * 0.6 + trendStrength * 0.4, 0, 1);
    } else if (volatility < VOLATILITY_THRESHOLD_LOW && Math.abs(cumulativeReturn) < 0.02) {
      regime = 'ranging';
      confidence = clamp(1 - volatility / VOLATILITY_THRESHOLD_LOW, 0.3, 0.9);
    } else if (Math.abs(avgReturn) > TREND_THRESHOLD * 0.5) {
      regime = avgReturn > 0 ? 'trending-up' : 'trending-down';
      confidence = clamp(directionConsistency * 0.5, 0.2, 0.7);
    } else {
      regime = 'ranging';
      confidence = 0.4;
    }

    const high = Math.max(...recent);
    const low = Math.min(...recent);
    const current = recent[recent.length - 1];

    // Store regime as knowledge
    this.upsertKnowledge(
      '__global__', 'regime', `regime:${upper}`,
      { regime, volatility, trendStrength },
      confidence,
    );

    return {
      symbol: upper,
      regime,
      confidence: Number(confidence.toFixed(4)),
      volatility: Number(volatility.toFixed(6)),
      trendStrength: Number(trendStrength.toFixed(4)),
      avgReturn: Number(avgReturn.toFixed(6)),
      priceRange: {
        high: Number(high.toFixed(4)),
        low: Number(low.toFixed(4)),
        current: Number(current.toFixed(4)),
      },
      dataPoints: recent.length,
      timestamp: isoNow(),
    };
  }

  // ─── Adaptive Parameter Tuning ────────────────────────────────────────

  /**
   * Analyze recent performance and suggest parameter adjustments.
   *
   * Adjustments include:
   * - Position size based on recent win rate
   * - Stop loss levels based on volatility
   * - Cooldown period based on trade frequency/performance
   */
  adaptParameters(agentId: string): AdaptiveParameters {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];

    const currentParams: Record<string, number> = {
      maxPositionSizePct: agent?.riskLimits?.maxPositionSizePct ?? 0.25,
      maxOrderNotionalUsd: agent?.riskLimits?.maxOrderNotionalUsd ?? 2500,
      dailyLossCapUsd: agent?.riskLimits?.dailyLossCapUsd ?? 1000,
      cooldownSeconds: agent?.riskLimits?.cooldownSeconds ?? 3,
      maxDrawdownPct: agent?.riskLimits?.maxDrawdownPct ?? 0.2,
    };

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const recentExecs = executions.slice(0, RECENT_WINDOW);
    const adjustments: ParameterAdjustment[] = [];
    const suggestedParams = { ...currentParams };

    if (recentExecs.length < 2) {
      const result: AdaptiveParameters = {
        agentId,
        previousParams: currentParams,
        suggestedParams,
        adjustments: [],
        appliedAt: isoNow(),
      };
      this.recordAdaptation(agentId, result);
      return result;
    }

    // Calculate recent performance metrics
    const recentPnls = recentExecs.map((ex) => ex.realizedPnlUsd);
    const recentWins = recentPnls.filter((p) => p > 0).length;
    const recentWinRate = recentPnls.length > 0 ? recentWins / recentPnls.length : 0.5;
    const recentAvgPnl = recentPnls.reduce((s, p) => s + p, 0) / recentPnls.length;

    // 1. Adjust position size based on win rate
    if (recentWinRate > 0.6) {
      const increase = Math.min(currentParams.maxPositionSizePct * 1.1, 0.5);
      suggestedParams.maxPositionSizePct = Number(increase.toFixed(4));
      adjustments.push({
        parameter: 'maxPositionSizePct',
        previousValue: currentParams.maxPositionSizePct,
        newValue: suggestedParams.maxPositionSizePct,
        reason: `High recent win rate (${(recentWinRate * 100).toFixed(1)}%) suggests room to increase position size`,
        confidenceLevel: Number(clamp(recentWinRate, 0, 1).toFixed(4)),
      });
    } else if (recentWinRate < 0.35) {
      const decrease = Math.max(currentParams.maxPositionSizePct * 0.85, 0.05);
      suggestedParams.maxPositionSizePct = Number(decrease.toFixed(4));
      adjustments.push({
        parameter: 'maxPositionSizePct',
        previousValue: currentParams.maxPositionSizePct,
        newValue: suggestedParams.maxPositionSizePct,
        reason: `Low recent win rate (${(recentWinRate * 100).toFixed(1)}%) suggests reducing position size to limit risk`,
        confidenceLevel: Number(clamp(1 - recentWinRate, 0, 1).toFixed(4)),
      });
    }

    // 2. Adjust cooldown based on performance trend
    if (recentAvgPnl < 0 && recentExecs.length >= 5) {
      const newCooldown = Math.min(currentParams.cooldownSeconds * 1.5, 300);
      suggestedParams.cooldownSeconds = Math.round(newCooldown);
      adjustments.push({
        parameter: 'cooldownSeconds',
        previousValue: currentParams.cooldownSeconds,
        newValue: suggestedParams.cooldownSeconds,
        reason: `Negative average PnL ($${recentAvgPnl.toFixed(2)}) suggests increasing cooldown to reduce overtrading`,
        confidenceLevel: Number(clamp(Math.abs(recentAvgPnl) / 100, 0.3, 0.9).toFixed(4)),
      });
    } else if (recentAvgPnl > 0 && recentWinRate > 0.55) {
      const newCooldown = Math.max(currentParams.cooldownSeconds * 0.8, 1);
      suggestedParams.cooldownSeconds = Math.round(newCooldown);
      if (suggestedParams.cooldownSeconds !== currentParams.cooldownSeconds) {
        adjustments.push({
          parameter: 'cooldownSeconds',
          previousValue: currentParams.cooldownSeconds,
          newValue: suggestedParams.cooldownSeconds,
          reason: `Positive performance trend suggests reducing cooldown to capture more opportunities`,
          confidenceLevel: Number(clamp(recentWinRate * 0.8, 0.3, 0.8).toFixed(4)),
        });
      }
    }

    // 3. Adjust daily loss cap based on drawdown
    if (agent) {
      const equity = agent.cashUsd +
        Object.values(agent.positions).reduce((s, p) => {
          const px = state.marketPricesUsd[p.symbol] ?? p.avgEntryPriceUsd;
          return s + (p.quantity * px);
        }, 0);
      const drawdown = agent.peakEquityUsd > 0
        ? (agent.peakEquityUsd - equity) / agent.peakEquityUsd
        : 0;

      if (drawdown > currentParams.maxDrawdownPct * 0.7) {
        const newLossCap = Math.max(currentParams.dailyLossCapUsd * 0.75, 100);
        suggestedParams.dailyLossCapUsd = Number(newLossCap.toFixed(2));
        adjustments.push({
          parameter: 'dailyLossCapUsd',
          previousValue: currentParams.dailyLossCapUsd,
          newValue: suggestedParams.dailyLossCapUsd,
          reason: `Approaching drawdown limit (${(drawdown * 100).toFixed(1)}% of ${(currentParams.maxDrawdownPct * 100).toFixed(0)}% max), tightening daily loss cap`,
          confidenceLevel: Number(clamp(drawdown / currentParams.maxDrawdownPct, 0.4, 0.95).toFixed(4)),
        });
      }
    }

    // Store knowledge
    this.upsertKnowledge(agentId, 'adaptation', 'latest-adaptation', {
      adjustmentCount: adjustments.length,
      recentWinRate,
      recentAvgPnl,
    }, recentWinRate);

    this.lastLearningCycle.set(agentId, isoNow());

    const result: AdaptiveParameters = {
      agentId,
      previousParams: currentParams,
      suggestedParams,
      adjustments,
      appliedAt: isoNow(),
    };

    this.recordAdaptation(agentId, result);
    return result;
  }

  // ─── Confidence Scoring ───────────────────────────────────────────────

  /**
   * Compute a confidence score for a potential trade signal on a symbol.
   *
   * Factors:
   * 1. Historical accuracy for this symbol
   * 2. Sample size reliability
   * 3. Recent performance trend
   * 4. Market regime alignment
   * 5. Profit factor
   */
  scoreConfidence(agentId: string, symbol: string): ConfidenceScore {
    const upper = symbol.toUpperCase();
    const state = this.store.snapshot();

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled' && ex.symbol === upper)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const allAgentExecs = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Determine dominant side for this symbol
    const buys = executions.filter((ex) => ex.side === 'buy');
    const sells = executions.filter((ex) => ex.side === 'sell');
    const dominantSide: Side = buys.length >= sells.length ? 'buy' : 'sell';

    const factors: ConfidenceFactor[] = [];

    // Factor 1: Historical accuracy
    const totalTrades = executions.length;
    const winTrades = executions.filter((ex) => ex.realizedPnlUsd > 0).length;
    const historicalAccuracy = totalTrades > 0 ? winTrades / totalTrades : 0.5;

    factors.push({
      name: 'historical_accuracy',
      weight: WEIGHT_HISTORICAL_ACCURACY,
      score: Number(clamp(historicalAccuracy * 100, 0, 100).toFixed(2)),
      contribution: Number((historicalAccuracy * WEIGHT_HISTORICAL_ACCURACY * 100).toFixed(2)),
    });

    // Factor 2: Sample size reliability
    const sampleSizeScore = clamp(Math.log2(totalTrades + 1) / Math.log2(50), 0, 1);
    factors.push({
      name: 'sample_size',
      weight: WEIGHT_SAMPLE_SIZE,
      score: Number((sampleSizeScore * 100).toFixed(2)),
      contribution: Number((sampleSizeScore * WEIGHT_SAMPLE_SIZE * 100).toFixed(2)),
    });

    // Factor 3: Recent performance trend
    const recentExecs = executions.slice(-Math.min(10, executions.length));
    const olderExecs = executions.slice(0, Math.max(0, executions.length - 10));

    let recentTrend: 'improving' | 'declining' | 'stable' = 'stable';
    let trendScore = 0.5;

    if (recentExecs.length >= 3 && olderExecs.length >= 3) {
      const recentWinRate = recentExecs.filter((ex) => ex.realizedPnlUsd > 0).length / recentExecs.length;
      const olderWinRate = olderExecs.filter((ex) => ex.realizedPnlUsd > 0).length / olderExecs.length;
      const delta = recentWinRate - olderWinRate;

      if (delta > 0.1) { recentTrend = 'improving'; trendScore = 0.5 + delta; }
      else if (delta < -0.1) { recentTrend = 'declining'; trendScore = 0.5 + delta; }
      else { trendScore = 0.5; }
    }

    trendScore = clamp(trendScore, 0, 1);
    factors.push({
      name: 'recent_trend',
      weight: WEIGHT_RECENT_TREND,
      score: Number((trendScore * 100).toFixed(2)),
      contribution: Number((trendScore * WEIGHT_RECENT_TREND * 100).toFixed(2)),
    });

    // Factor 4: Regime alignment
    const regimeData = this.detectRegime(upper);
    let regimeAlignment = 0.5;
    if (regimeData.regime === 'trending-up' && dominantSide === 'buy') regimeAlignment = 0.8;
    else if (regimeData.regime === 'trending-down' && dominantSide === 'sell') regimeAlignment = 0.8;
    else if (regimeData.regime === 'volatile') regimeAlignment = 0.3;
    else if (regimeData.regime === 'ranging') regimeAlignment = 0.5;
    else if (regimeData.regime === 'unknown') regimeAlignment = 0.5;

    regimeAlignment *= regimeData.confidence > 0 ? regimeData.confidence : 0.5;
    regimeAlignment = clamp(regimeAlignment, 0, 1);

    factors.push({
      name: 'regime_alignment',
      weight: WEIGHT_REGIME_ALIGNMENT,
      score: Number((regimeAlignment * 100).toFixed(2)),
      contribution: Number((regimeAlignment * WEIGHT_REGIME_ALIGNMENT * 100).toFixed(2)),
    });

    // Factor 5: Profit factor
    const winPnl = executions.filter((ex) => ex.realizedPnlUsd > 0).reduce((s, ex) => s + ex.realizedPnlUsd, 0);
    const lossPnl = Math.abs(executions.filter((ex) => ex.realizedPnlUsd < 0).reduce((s, ex) => s + ex.realizedPnlUsd, 0));
    const profitFactor = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 3 : 0);
    const pfScore = clamp(profitFactor / 3, 0, 1);

    factors.push({
      name: 'profit_factor',
      weight: WEIGHT_PROFIT_FACTOR,
      score: Number((pfScore * 100).toFixed(2)),
      contribution: Number((pfScore * WEIGHT_PROFIT_FACTOR * 100).toFixed(2)),
    });

    // Composite confidence
    const rawConfidence = factors.reduce((sum, f) => sum + (f.score / 100 * f.weight), 0);
    const confidence = Number(clamp(rawConfidence * 100, 0, 100).toFixed(2));

    return {
      symbol: upper,
      side: dominantSide,
      confidence,
      historicalAccuracy: Number((historicalAccuracy * 100).toFixed(2)),
      sampleSize: totalTrades,
      recentTrend,
      regimeAlignment: Number((regimeAlignment * 100).toFixed(2)),
      factors,
      timestamp: isoNow(),
    };
  }

  // ─── Learning Metrics Dashboard ───────────────────────────────────────

  /**
   * Get comprehensive learning metrics for an agent.
   */
  getLearningMetrics(agentId: string): LearningMetrics {
    const state = this.store.snapshot();
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled');

    const knowledge = this.knowledgeBase.get(agentId) ?? [];
    const adaptations = this.adaptationHistory.get(agentId) ?? [];

    // Compute recent accuracy
    const recentExecs = executions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, RECENT_WINDOW);
    const recentWins = recentExecs.filter((ex) => ex.realizedPnlUsd > 0).length;
    const recentAccuracy = recentExecs.length > 0 ? recentWins / recentExecs.length : 0;

    // Compute improvement over baseline (first half vs second half of trades)
    const sorted = executions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const midpoint = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, midpoint);
    const secondHalf = sorted.slice(midpoint);

    const firstWinRate = firstHalf.length > 0
      ? firstHalf.filter((ex) => ex.realizedPnlUsd > 0).length / firstHalf.length
      : 0;
    const secondWinRate = secondHalf.length > 0
      ? secondHalf.filter((ex) => ex.realizedPnlUsd > 0).length / secondHalf.length
      : 0;

    const improvement = firstWinRate > 0
      ? ((secondWinRate - firstWinRate) / firstWinRate) * 100
      : 0;

    // Count detected regimes from global knowledge
    const globalKnowledge = this.knowledgeBase.get('__global__') ?? [];
    const regimeCounts: Record<MarketRegime, number> = {
      'trending-up': 0,
      'trending-down': 0,
      'ranging': 0,
      'volatile': 0,
      'unknown': 0,
    };

    for (const entry of globalKnowledge) {
      if (entry.category === 'regime' && typeof entry.value === 'object' && entry.value !== null) {
        const regime = (entry.value as Record<string, unknown>).regime as MarketRegime;
        if (regime in regimeCounts) regimeCounts[regime]++;
      }
    }

    // Average confidence from knowledge base
    const allConfidences = knowledge.map((k) => k.confidence).filter((c) => c > 0);
    const avgConfidence = allConfidences.length > 0
      ? Number((allConfidences.reduce((s, c) => s + c, 0) / allConfidences.length * 100).toFixed(2))
      : 0;

    // Learning rate: trades analyzed per adaptation
    const learningRate = adaptations.length > 0
      ? Number((executions.length / adaptations.length).toFixed(2))
      : 0;

    return {
      agentId,
      totalTradesAnalyzed: executions.length,
      totalPatternsLearned: knowledge.filter((k) => k.category === 'pattern').length,
      knowledgeBaseSize: knowledge.length,
      adaptationCount: adaptations.length,
      avgConfidence,
      learningRate,
      recentAccuracy: Number((recentAccuracy * 100).toFixed(2)),
      regimesDetected: regimeCounts,
      improvementOverBaseline: Number(improvement.toFixed(2)),
      lastLearningCycleAt: this.lastLearningCycle.get(agentId) ?? null,
      timestamp: isoNow(),
    };
  }

  // ─── Knowledge Base Management ────────────────────────────────────────

  /**
   * Get all knowledge entries for an agent.
   */
  getKnowledge(agentId: string): KnowledgeEntry[] {
    return (this.knowledgeBase.get(agentId) ?? []).map((e) => ({ ...e }));
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private upsertKnowledge(
    agentId: string,
    category: KnowledgeEntry['category'],
    key: string,
    value: unknown,
    confidence: number,
  ): void {
    if (!this.knowledgeBase.has(agentId)) {
      this.knowledgeBase.set(agentId, []);
    }

    const entries = this.knowledgeBase.get(agentId)!;
    const existing = entries.find((e) => e.key === key);

    if (existing) {
      existing.value = value;
      existing.confidence = confidence;
      existing.updatedAt = isoNow();
      existing.accessCount += 1;
    } else {
      entries.push({
        id: generateId(),
        agentId,
        category,
        key,
        value,
        confidence,
        createdAt: isoNow(),
        updatedAt: isoNow(),
        accessCount: 1,
      });

      // Prune if over limit
      if (entries.length > MAX_KNOWLEDGE_ENTRIES) {
        entries.sort((a, b) => a.accessCount - b.accessCount);
        entries.splice(0, entries.length - MAX_KNOWLEDGE_ENTRIES);
      }
    }
  }

  private recordAdaptation(agentId: string, adaptation: AdaptiveParameters): void {
    if (!this.adaptationHistory.has(agentId)) {
      this.adaptationHistory.set(agentId, []);
    }
    const history = this.adaptationHistory.get(agentId)!;
    history.push(adaptation);

    // Keep last 100 adaptations
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
  }
}
