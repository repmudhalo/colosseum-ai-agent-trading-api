/**
 * Trade History & Performance Tracking Service.
 *
 * Tracks complete trade history per agent with enriched data.
 * Hooks into eventBus 'intent.executed' to auto-record trades.
 * Provides paginated history, performance summaries, and win/loss streaks.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow, dayKey } from '../utils/time.js';
import { Side, ExecutionMode } from '../types.js';

export interface TradeRecord {
  id: string;
  agentId: string;
  executionId: string;
  intentId: string;
  symbol: string;
  side: Side;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  feeUsd: number;
  netUsd: number;
  realizedPnlUsd: number;
  mode: ExecutionMode;
  recordedAt: string;
  day: string;
}

export interface TradeHistoryOptions {
  symbol?: string;
  side?: Side;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface PerformanceSummary {
  agentId: string;
  totalTrades: number;
  totalVolume: number;
  totalPnl: number;
  avgTradeSize: number;
  bestTrade: { pnl: number; symbol: string; recordedAt: string } | null;
  worstTrade: { pnl: number; symbol: string; recordedAt: string } | null;
  winCount: number;
  lossCount: number;
  winRate: number;
  dailyBreakdown: Array<{ day: string; trades: number; pnl: number; volume: number }>;
}

export interface StreakInfo {
  agentId: string;
  currentStreak: { type: 'win' | 'loss' | 'none'; length: number };
  longestWinStreak: number;
  longestLossStreak: number;
}

const MAX_RECORDS = 50_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class TradeHistoryService {
  /** agentId → TradeRecord[] (ordered by recordedAt) */
  private trades: Map<string, TradeRecord[]> = new Map();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: StateStore) {}

  /**
   * Start listening to eventBus for auto-recording.
   */
  startListening(): void {
    this.unsubscribe = eventBus.on('intent.executed', (_event, data) => {
      const payload = data as {
        executionId: string;
        intentId: string;
        agentId: string;
        symbol: string;
        side: Side;
        quantity: number;
        priceUsd: number;
        grossNotionalUsd: number;
        feeUsd: number;
        netUsd: number;
        realizedPnlUsd: number;
        mode: ExecutionMode;
      };

      if (payload.agentId && payload.executionId) {
        this.recordTrade(payload.agentId, payload);
      }
    });
  }

  /**
   * Stop listening.
   */
  stopListening(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Record an enriched trade record.
   */
  recordTrade(
    agentId: string,
    execution: {
      executionId: string;
      intentId: string;
      symbol: string;
      side: Side;
      quantity: number;
      priceUsd: number;
      grossNotionalUsd: number;
      feeUsd: number;
      netUsd: number;
      realizedPnlUsd: number;
      mode: ExecutionMode;
    },
  ): TradeRecord {
    const now = isoNow();
    const record: TradeRecord = {
      id: uuid(),
      agentId,
      executionId: execution.executionId,
      intentId: execution.intentId,
      symbol: execution.symbol.toUpperCase(),
      side: execution.side,
      quantity: execution.quantity,
      priceUsd: execution.priceUsd,
      grossNotionalUsd: execution.grossNotionalUsd,
      feeUsd: execution.feeUsd,
      netUsd: execution.netUsd,
      realizedPnlUsd: execution.realizedPnlUsd,
      mode: execution.mode,
      recordedAt: now,
      day: dayKey(now),
    };

    if (!this.trades.has(agentId)) {
      this.trades.set(agentId, []);
    }

    const agentTrades = this.trades.get(agentId)!;
    agentTrades.push(record);

    // Trim if over limit
    if (agentTrades.length > MAX_RECORDS) {
      agentTrades.splice(0, agentTrades.length - MAX_RECORDS);
    }

    return structuredClone(record);
  }

  /**
   * Get paginated, filterable trade history for an agent.
   */
  getTradeHistory(agentId: string, opts?: TradeHistoryOptions): { trades: TradeRecord[]; total: number } {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const agentTrades = this.trades.get(agentId) ?? [];
    let filtered = agentTrades;

    if (opts?.symbol) {
      const upper = opts.symbol.toUpperCase();
      filtered = filtered.filter((t) => t.symbol === upper);
    }

    if (opts?.side) {
      filtered = filtered.filter((t) => t.side === opts.side);
    }

    if (opts?.startDate) {
      filtered = filtered.filter((t) => t.recordedAt >= opts.startDate!);
    }

    if (opts?.endDate) {
      filtered = filtered.filter((t) => t.recordedAt <= opts.endDate!);
    }

    // Sort newest first
    const sorted = [...filtered].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

    const total = sorted.length;
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(opts?.offset ?? 0, 0);

    return {
      trades: sorted.slice(offset, offset + limit).map((t) => structuredClone(t)),
      total,
    };
  }

  /**
   * Get performance summary for an agent.
   */
  getPerformanceSummary(agentId: string): PerformanceSummary {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const agentTrades = this.trades.get(agentId) ?? [];

    if (agentTrades.length === 0) {
      return {
        agentId,
        totalTrades: 0,
        totalVolume: 0,
        totalPnl: 0,
        avgTradeSize: 0,
        bestTrade: null,
        worstTrade: null,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
        dailyBreakdown: [],
      };
    }

    let totalVolume = 0;
    let totalPnl = 0;
    let bestTrade: TradeRecord | null = null;
    let worstTrade: TradeRecord | null = null;
    let winCount = 0;
    let lossCount = 0;

    const dailyMap: Map<string, { trades: number; pnl: number; volume: number }> = new Map();

    for (const trade of agentTrades) {
      totalVolume += trade.grossNotionalUsd;
      totalPnl += trade.realizedPnlUsd;

      if (trade.realizedPnlUsd > 0) winCount++;
      if (trade.realizedPnlUsd < 0) lossCount++;

      if (!bestTrade || trade.realizedPnlUsd > bestTrade.realizedPnlUsd) {
        bestTrade = trade;
      }
      if (!worstTrade || trade.realizedPnlUsd < worstTrade.realizedPnlUsd) {
        worstTrade = trade;
      }

      const day = trade.day;
      if (!dailyMap.has(day)) {
        dailyMap.set(day, { trades: 0, pnl: 0, volume: 0 });
      }
      const d = dailyMap.get(day)!;
      d.trades += 1;
      d.pnl += trade.realizedPnlUsd;
      d.volume += trade.grossNotionalUsd;
    }

    const pnlTrades = winCount + lossCount;

    return {
      agentId,
      totalTrades: agentTrades.length,
      totalVolume: Number(totalVolume.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      avgTradeSize: Number((totalVolume / agentTrades.length).toFixed(2)),
      bestTrade: bestTrade
        ? { pnl: bestTrade.realizedPnlUsd, symbol: bestTrade.symbol, recordedAt: bestTrade.recordedAt }
        : null,
      worstTrade: worstTrade
        ? { pnl: worstTrade.realizedPnlUsd, symbol: worstTrade.symbol, recordedAt: worstTrade.recordedAt }
        : null,
      winCount,
      lossCount,
      winRate: pnlTrades > 0 ? Number(((winCount / pnlTrades) * 100).toFixed(2)) : 0,
      dailyBreakdown: Array.from(dailyMap.entries())
        .map(([day, data]) => ({
          day,
          trades: data.trades,
          pnl: Number(data.pnl.toFixed(2)),
          volume: Number(data.volume.toFixed(2)),
        }))
        .sort((a, b) => b.day.localeCompare(a.day)),
    };
  }

  /**
   * Get win/loss streak information for an agent.
   */
  getStreaks(agentId: string): StreakInfo {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const agentTrades = this.trades.get(agentId) ?? [];

    if (agentTrades.length === 0) {
      return {
        agentId,
        currentStreak: { type: 'none', length: 0 },
        longestWinStreak: 0,
        longestLossStreak: 0,
      };
    }

    // Sorted oldest first for streak calculation
    const sorted = [...agentTrades].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

    let longestWin = 0;
    let longestLoss = 0;
    let currentWin = 0;
    let currentLoss = 0;

    for (const trade of sorted) {
      if (trade.realizedPnlUsd > 0) {
        currentWin++;
        currentLoss = 0;
        if (currentWin > longestWin) longestWin = currentWin;
      } else if (trade.realizedPnlUsd < 0) {
        currentLoss++;
        currentWin = 0;
        if (currentLoss > longestLoss) longestLoss = currentLoss;
      } else {
        // Break-even resets both
        currentWin = 0;
        currentLoss = 0;
      }
    }

    let currentType: 'win' | 'loss' | 'none' = 'none';
    let currentLength = 0;

    if (currentWin > 0) {
      currentType = 'win';
      currentLength = currentWin;
    } else if (currentLoss > 0) {
      currentType = 'loss';
      currentLength = currentLoss;
    }

    return {
      agentId,
      currentStreak: { type: currentType, length: currentLength },
      longestWinStreak: longestWin,
      longestLossStreak: longestLoss,
    };
  }
}
