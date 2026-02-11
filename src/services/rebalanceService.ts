/**
 * Portfolio Rebalancing Engine.
 *
 * Agents define target allocations (e.g., {SOL: 60%, USDC: 40%}).
 * The service compares current positions vs target, computes drift,
 * and suggests required trades when drift exceeds a threshold (default 5%).
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { isoNow } from '../utils/time.js';

export interface TargetAllocation {
  /** Asset symbol → target weight (0..1). Must sum to 1. */
  [symbol: string]: number;
}

export interface DriftEntry {
  symbol: string;
  targetPct: number;
  currentPct: number;
  driftPct: number;
  currentValueUsd: number;
  targetValueUsd: number;
  deltaUsd: number;
}

export interface SuggestedTrade {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
}

export interface RebalanceStatus {
  agentId: string;
  equityUsd: number;
  drift: DriftEntry[];
  suggestedTrades: SuggestedTrade[];
  needsRebalance: boolean;
  updatedAt: string;
}

export interface RebalanceResult {
  agentId: string;
  tradesCreated: number;
  trades: SuggestedTrade[];
}

const DEFAULT_DRIFT_THRESHOLD_PCT = 5;

export class RebalanceService {
  private targetAllocations: Map<string, TargetAllocation> = new Map();
  private readonly driftThresholdPct: number;

  constructor(
    private readonly store: StateStore,
    options?: { driftThresholdPct?: number },
  ) {
    this.driftThresholdPct = options?.driftThresholdPct ?? DEFAULT_DRIFT_THRESHOLD_PCT;
  }

  /**
   * Set target allocation for an agent.
   * Allocations must be an object mapping symbols to weights summing to 1.
   */
  setTargetAllocation(agentId: string, allocations: TargetAllocation): TargetAllocation {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    // Validate weights sum to ~1
    const entries = Object.entries(allocations);
    if (entries.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Allocations must not be empty.');
    }

    for (const [symbol, weight] of entries) {
      if (typeof weight !== 'number' || weight < 0 || weight > 1) {
        throw new DomainError(
          ErrorCode.InvalidPayload,
          400,
          `Invalid weight for ${symbol}. Must be between 0 and 1.`,
        );
      }
    }

    const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
    if (Math.abs(totalWeight - 1) > 0.01) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Allocations must sum to 1. Got ${totalWeight.toFixed(4)}.`,
      );
    }

    // Normalize symbols to uppercase
    const normalized: TargetAllocation = {};
    for (const [symbol, weight] of entries) {
      normalized[symbol.toUpperCase()] = weight;
    }

    this.targetAllocations.set(agentId, normalized);
    return structuredClone(normalized);
  }

  /**
   * Get the target allocation for an agent (if set).
   */
  getTargetAllocation(agentId: string): TargetAllocation | null {
    return this.targetAllocations.has(agentId)
      ? structuredClone(this.targetAllocations.get(agentId)!)
      : null;
  }

  /**
   * Calculate rebalance status: current drift and suggested trades.
   */
  calculateRebalance(agentId: string): RebalanceStatus {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const target = this.targetAllocations.get(agentId);
    if (!target) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'No target allocation set for this agent.');
    }

    // Calculate total equity
    const positionValues: Record<string, number> = {};
    for (const pos of Object.values(agent.positions)) {
      const price = state.marketPricesUsd[pos.symbol] ?? pos.avgEntryPriceUsd;
      positionValues[pos.symbol] = pos.quantity * price;
    }

    // Include cash as USDC
    const cashSymbol = 'USDC';
    positionValues[cashSymbol] = (positionValues[cashSymbol] ?? 0) + agent.cashUsd;

    const totalEquity = Object.values(positionValues).reduce((sum, v) => sum + v, 0);

    if (totalEquity <= 0) {
      return {
        agentId,
        equityUsd: 0,
        drift: [],
        suggestedTrades: [],
        needsRebalance: false,
        updatedAt: isoNow(),
      };
    }

    // Calculate drift for each target symbol
    const drift: DriftEntry[] = [];
    const suggestedTrades: SuggestedTrade[] = [];
    let needsRebalance = false;

    for (const [symbol, targetPct] of Object.entries(target)) {
      const currentValue = positionValues[symbol] ?? 0;
      const currentPct = (currentValue / totalEquity) * 100;
      const targetPctScaled = targetPct * 100;
      const driftPct = currentPct - targetPctScaled;
      const targetValueUsd = totalEquity * targetPct;
      const deltaUsd = targetValueUsd - currentValue;

      drift.push({
        symbol,
        targetPct: Number(targetPctScaled.toFixed(2)),
        currentPct: Number(currentPct.toFixed(2)),
        driftPct: Number(driftPct.toFixed(2)),
        currentValueUsd: Number(currentValue.toFixed(2)),
        targetValueUsd: Number(targetValueUsd.toFixed(2)),
        deltaUsd: Number(deltaUsd.toFixed(2)),
      });

      if (Math.abs(driftPct) > this.driftThresholdPct) {
        needsRebalance = true;

        // Skip USDC — rebalancing is done by buying/selling other assets
        if (symbol !== 'USDC') {
          suggestedTrades.push({
            symbol,
            side: deltaUsd > 0 ? 'buy' : 'sell',
            notionalUsd: Number(Math.abs(deltaUsd).toFixed(2)),
          });
        }
      }
    }

    return {
      agentId,
      equityUsd: Number(totalEquity.toFixed(2)),
      drift,
      suggestedTrades,
      needsRebalance,
      updatedAt: isoNow(),
    };
  }

  /**
   * Alias for calculateRebalance — returns drift status.
   */
  getRebalanceStatus(agentId: string): RebalanceStatus {
    return this.calculateRebalance(agentId);
  }

  /**
   * Execute rebalance — returns the trades that would be created.
   * In a real system this would submit trade intents; here we return the plan.
   */
  executeRebalance(agentId: string): RebalanceResult {
    const status = this.calculateRebalance(agentId);

    if (!status.needsRebalance) {
      return {
        agentId,
        tradesCreated: 0,
        trades: [],
      };
    }

    return {
      agentId,
      tradesCreated: status.suggestedTrades.length,
      trades: status.suggestedTrades,
    };
  }
}
