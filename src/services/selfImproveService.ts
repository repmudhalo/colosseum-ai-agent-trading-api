import { v4 as uuid } from 'uuid';
import {
  ImprovementRecord,
  Pattern,
  PerformanceAnalysis,
  Recommendation,
  RecommendationType,
} from '../domain/improve/types.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { ExecutionRecord, StrategyId } from '../types.js';
import { isoNow } from '../utils/time.js';

export class SelfImproveService {
  private readonly improvementHistory: Map<string, ImprovementRecord[]> = new Map();
  private readonly recommendations: Map<string, Recommendation[]> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Analyze recent performance for an agent. Examines last N executions and computes
   * win/loss patterns, strategy effectiveness, risk rejection rates, and drawdown patterns.
   */
  analyzePerformance(agentId: string): PerformanceAnalysis {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found.`);
    }

    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);

    const executionCount = executions.length;

    if (executionCount === 0) {
      const analysis: PerformanceAnalysis = {
        agentId,
        analyzedAt: isoNow(),
        executionCount: 0,
        winRate: 0,
        avgReturnPct: 0,
        bestStrategy: agent.strategyId,
        worstStrategy: agent.strategyId,
        riskRejectionRate: 0,
        patterns: [],
      };

      eventBus.emit('improve.analyzed', { agentId, executionCount: 0 });
      return analysis;
    }

    // Win/loss analysis
    const wins = executions.filter((ex) => ex.realizedPnlUsd > 0);
    const winRate = (wins.length / executionCount) * 100;

    // Average return
    const totalReturn = executions.reduce((sum, ex) => {
      if (ex.grossNotionalUsd > 0) {
        return sum + (ex.realizedPnlUsd / ex.grossNotionalUsd) * 100;
      }
      return sum;
    }, 0);
    const avgReturnPct = totalReturn / executionCount;

    // Strategy effectiveness — group by strategy used at time of execution
    const strategyStats = this.computeStrategyStats(executions, state.agents);
    const strategies = Object.entries(strategyStats);
    const bestStrategy = strategies.length > 0
      ? strategies.reduce((best, cur) => (cur[1].winRate > best[1].winRate ? cur : best))[0]
      : agent.strategyId;
    const worstStrategy = strategies.length > 0
      ? strategies.reduce((worst, cur) => (cur[1].winRate < worst[1].winRate ? cur : worst))[0]
      : agent.strategyId;

    // Risk rejection rate
    const totalRejections = Object.values(agent.riskRejectionsByReason).reduce((s, v) => s + v, 0);
    const totalAttempts = executionCount + totalRejections;
    const riskRejectionRate = totalAttempts > 0 ? (totalRejections / totalAttempts) * 100 : 0;

    // Patterns
    const patterns = this.detectPatterns(executions);

    const analysis: PerformanceAnalysis = {
      agentId,
      analyzedAt: isoNow(),
      executionCount,
      winRate: Number(winRate.toFixed(2)),
      avgReturnPct: Number(avgReturnPct.toFixed(4)),
      bestStrategy,
      worstStrategy,
      riskRejectionRate: Number(riskRejectionRate.toFixed(2)),
      patterns,
    };

    eventBus.emit('improve.analyzed', { agentId, executionCount });
    return analysis;
  }

  /**
   * Generate actionable recommendations based on a performance analysis.
   */
  generateRecommendations(analysis: PerformanceAnalysis): Recommendation[] {
    const recs: Recommendation[] = [];

    // Strategy switch recommendation
    if (analysis.bestStrategy !== analysis.worstStrategy && analysis.executionCount >= 2) {
      recs.push({
        id: uuid(),
        type: 'strategy-switch',
        description: `Switch to ${analysis.bestStrategy} — it outperforms ${analysis.worstStrategy} based on recent trades.`,
        confidence: Math.min(0.5 + analysis.executionCount * 0.01, 0.95),
        expectedImpactPct: Number(Math.abs(analysis.avgReturnPct * 0.3).toFixed(2)),
        parameters: {
          fromStrategy: analysis.worstStrategy,
          toStrategy: analysis.bestStrategy,
        },
      });
    }

    // Risk adjustment recommendation
    if (analysis.riskRejectionRate > 20) {
      recs.push({
        id: uuid(),
        type: 'risk-adjustment',
        description: `Risk rejection rate is ${analysis.riskRejectionRate}% — consider relaxing maxOrderNotionalUsd by 15% to allow more trades through.`,
        confidence: Math.min(0.6 + (analysis.riskRejectionRate - 20) * 0.005, 0.9),
        expectedImpactPct: Number((analysis.riskRejectionRate * 0.2).toFixed(2)),
        parameters: {
          adjustment: 'increase',
          field: 'maxOrderNotionalUsd',
          changePct: 15,
        },
      });
    }

    // Timing optimization based on patterns
    const timingPattern = analysis.patterns.find((p) => p.type === 'time-of-day');
    if (timingPattern && timingPattern.metric > 60) {
      recs.push({
        id: uuid(),
        type: 'timing-optimization',
        description: timingPattern.description,
        confidence: 0.65,
        expectedImpactPct: 5.0,
        parameters: {
          pattern: timingPattern,
        },
      });
    }

    // Position sizing recommendation
    const sizePattern = analysis.patterns.find((p) => p.type === 'size');
    if (sizePattern) {
      recs.push({
        id: uuid(),
        type: 'position-sizing',
        description: sizePattern.description,
        confidence: 0.6,
        expectedImpactPct: Number((Math.abs(analysis.avgReturnPct) * 0.2).toFixed(2)),
        parameters: {
          pattern: sizePattern,
          suggestedSizePct: 0.08,
        },
      });
    }

    // Low win rate → suggest risk tightening
    if (analysis.winRate < 40 && analysis.executionCount >= 5) {
      recs.push({
        id: uuid(),
        type: 'risk-adjustment',
        description: `Win rate is only ${analysis.winRate}% — tighten maxDrawdownPct to protect capital.`,
        confidence: 0.75,
        expectedImpactPct: 8.0,
        parameters: {
          adjustment: 'decrease',
          field: 'maxDrawdownPct',
          changePct: 20,
        },
      });
    }

    this.recommendations.set(analysis.agentId, recs);
    return recs;
  }

  /**
   * Apply a specific recommendation for an agent.
   */
  async applyRecommendation(agentId: string, recommendationId: string): Promise<ImprovementRecord> {
    const recs = this.recommendations.get(agentId);
    if (!recs) {
      throw new Error(`No recommendations found for agent '${agentId}'.`);
    }

    const rec = recs.find((r) => r.id === recommendationId);
    if (!rec) {
      throw new Error(`Recommendation '${recommendationId}' not found.`);
    }

    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found.`);
    }

    const pnlBefore = agent.realizedPnlUsd;

    // Apply based on type
    if (rec.type === 'strategy-switch') {
      const toStrategy = rec.parameters.toStrategy as StrategyId;
      await this.store.transaction((s) => {
        const a = s.agents[agentId];
        if (a) {
          a.strategyId = toStrategy;
          a.updatedAt = isoNow();
        }
        return undefined;
      });
    } else if (rec.type === 'risk-adjustment') {
      const field = rec.parameters.field as string;
      const changePct = rec.parameters.changePct as number;
      const adjustment = rec.parameters.adjustment as string;

      await this.store.transaction((s) => {
        const a = s.agents[agentId];
        if (a) {
          const limits = a.riskLimits as unknown as Record<string, number>;
          const current = limits[field];
          if (current !== undefined) {
            const multiplier = adjustment === 'increase' ? (1 + changePct / 100) : (1 - changePct / 100);
            limits[field] = Number((current * multiplier).toFixed(4));
          }
          a.updatedAt = isoNow();
        }
        return undefined;
      });
    }

    const record: ImprovementRecord = {
      id: uuid(),
      agentId,
      timestamp: isoNow(),
      recommendation: rec,
      applied: true,
      resultPnlBefore: pnlBefore,
      resultPnlAfter: null,
    };

    const history = this.improvementHistory.get(agentId) ?? [];
    history.push(record);
    this.improvementHistory.set(agentId, history);

    // Remove applied recommendation
    this.recommendations.set(agentId, recs.filter((r) => r.id !== recommendationId));

    eventBus.emit('improve.applied', {
      agentId,
      recommendationId: rec.id,
      type: rec.type,
    });

    return record;
  }

  /**
   * Get current (unapplied) recommendations for an agent.
   */
  getRecommendations(agentId: string): Recommendation[] {
    return this.recommendations.get(agentId) ?? [];
  }

  /**
   * Get all past improvement records for an agent.
   */
  getImprovementHistory(agentId: string): ImprovementRecord[] {
    return this.improvementHistory.get(agentId) ?? [];
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private computeStrategyStats(
    executions: ExecutionRecord[],
    agents: Record<string, { strategyId: string }>,
  ): Record<string, { winRate: number; count: number }> {
    // Group all executions by the agent's current strategy (simplified; in a real
    // system we'd track which strategy was active per execution)
    const groups: Record<string, { wins: number; total: number }> = {};

    for (const ex of executions) {
      const agentData = agents[ex.agentId];
      const strategy = agentData?.strategyId ?? 'unknown';

      if (!groups[strategy]) {
        groups[strategy] = { wins: 0, total: 0 };
      }
      groups[strategy].total += 1;
      if (ex.realizedPnlUsd > 0) {
        groups[strategy].wins += 1;
      }
    }

    const result: Record<string, { winRate: number; count: number }> = {};
    for (const [strat, stats] of Object.entries(groups)) {
      result[strat] = {
        winRate: stats.total > 0 ? (stats.wins / stats.total) * 100 : 0,
        count: stats.total,
      };
    }
    return result;
  }

  private detectPatterns(executions: ExecutionRecord[]): Pattern[] {
    const patterns: Pattern[] = [];

    if (executions.length === 0) return patterns;

    // Time-of-day pattern — check if afternoon trades do better
    const hourGroups: Record<string, { wins: number; total: number }> = {};
    for (const ex of executions) {
      const hour = new Date(ex.createdAt).getUTCHours();
      const bucket = hour < 12 ? 'morning' : 'afternoon';
      if (!hourGroups[bucket]) hourGroups[bucket] = { wins: 0, total: 0 };
      hourGroups[bucket].total += 1;
      if (ex.realizedPnlUsd > 0) hourGroups[bucket].wins += 1;
    }

    const morning = hourGroups['morning'];
    const afternoon = hourGroups['afternoon'];
    if (morning && afternoon && morning.total > 0 && afternoon.total > 0) {
      const morningWR = (morning.wins / morning.total) * 100;
      const afternoonWR = (afternoon.wins / afternoon.total) * 100;
      const better = afternoonWR > morningWR ? 'afternoon (12:00-23:59 UTC)' : 'morning (00:00-11:59 UTC)';
      const betterRate = Math.max(morningWR, afternoonWR);

      patterns.push({
        type: 'time-of-day',
        description: `Best performance during ${better} — ${betterRate.toFixed(1)}% win rate.`,
        metric: Number(betterRate.toFixed(2)),
      });
    }

    // Size pattern — compare small vs large trades
    const sortedByNotional = [...executions].sort((a, b) => a.grossNotionalUsd - b.grossNotionalUsd);
    const mid = Math.floor(sortedByNotional.length / 2);
    if (mid > 0) {
      const smallTrades = sortedByNotional.slice(0, mid);
      const largeTrades = sortedByNotional.slice(mid);

      const smallWinRate = smallTrades.filter((t) => t.realizedPnlUsd > 0).length / smallTrades.length;
      const largeWinRate = largeTrades.filter((t) => t.realizedPnlUsd > 0).length / largeTrades.length;

      if (smallWinRate !== largeWinRate) {
        const better = smallWinRate > largeWinRate ? 'smaller' : 'larger';
        patterns.push({
          type: 'size',
          description: `${better} position sizes have higher win rate — consider adjusting position sizing.`,
          metric: Number(Math.max(smallWinRate, largeWinRate).toFixed(4)),
        });
      }
    }

    return patterns;
  }
}
