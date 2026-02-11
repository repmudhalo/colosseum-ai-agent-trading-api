import { v4 as uuid } from 'uuid';
import {
  InferenceBudget,
  InferenceCall,
  InferenceROI,
} from '../domain/improve/types.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

const DEFAULT_INFERENCE_ALLOCATION_PCT = 10; // 10% of profits go to AI budget

export class InferenceBudgetService {
  private readonly budgets: Map<string, { totalAllocatedUsd: number; allocationPct: number }> = new Map();
  private readonly calls: Map<string, InferenceCall[]> = new Map();
  private readonly profitSnapshots: Map<string, number> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Allocate a percentage of profits to the inference budget.
   */
  allocateFromProfits(agentId: string, profitUsd: number): InferenceBudget {
    if (profitUsd <= 0) {
      return this.getInferenceBudget(agentId);
    }

    const budget = this.budgets.get(agentId) ?? {
      totalAllocatedUsd: 0,
      allocationPct: DEFAULT_INFERENCE_ALLOCATION_PCT,
    };

    const allocation = profitUsd * (budget.allocationPct / 100);
    budget.totalAllocatedUsd += allocation;
    this.budgets.set(agentId, budget);

    return this.getInferenceBudget(agentId);
  }

  /**
   * Get the current inference budget for an agent.
   */
  getInferenceBudget(agentId: string): InferenceBudget {
    const budget = this.budgets.get(agentId) ?? {
      totalAllocatedUsd: 0,
      allocationPct: DEFAULT_INFERENCE_ALLOCATION_PCT,
    };

    const totalSpent = this.getTotalSpent(agentId);
    const available = Math.max(0, budget.totalAllocatedUsd - totalSpent);

    return {
      agentId,
      totalAllocatedUsd: Number(budget.totalAllocatedUsd.toFixed(6)),
      totalSpentUsd: Number(totalSpent.toFixed(6)),
      availableUsd: Number(available.toFixed(6)),
      inferenceAllocationPct: budget.allocationPct,
    };
  }

  /**
   * Record an AI inference call and deduct from budget.
   * Returns false if insufficient budget.
   */
  recordInferenceCall(
    agentId: string,
    cost: number,
    provider: string,
    purpose: string,
  ): InferenceCall | null {
    const budget = this.getInferenceBudget(agentId);
    if (budget.availableUsd < cost) {
      return null; // Insufficient budget
    }

    const call: InferenceCall = {
      id: uuid(),
      agentId,
      timestamp: isoNow(),
      provider,
      purpose,
      costUsd: cost,
    };

    const history = this.calls.get(agentId) ?? [];
    history.push(call);
    this.calls.set(agentId, history);

    return call;
  }

  /**
   * Get inference call history for an agent.
   */
  getInferenceHistory(agentId: string): InferenceCall[] {
    return this.calls.get(agentId) ?? [];
  }

  /**
   * Calculate ROI on inference spending.
   * ROI = (profit improvement) / (total inference cost)
   */
  getROI(agentId: string): InferenceROI {
    const totalSpent = this.getTotalSpent(agentId);
    const state = this.store.snapshot();
    const agent = state.agents[agentId];

    const currentPnl = agent?.realizedPnlUsd ?? 0;
    const baselinePnl = this.profitSnapshots.get(agentId) ?? 0;
    const profitImprovement = currentPnl - baselinePnl;

    const calls = this.calls.get(agentId) ?? [];

    return {
      agentId,
      totalInferenceSpentUsd: Number(totalSpent.toFixed(6)),
      profitImprovementUsd: Number(profitImprovement.toFixed(6)),
      roi: totalSpent > 0 ? Number((profitImprovement / totalSpent).toFixed(4)) : 0,
      cyclesRun: calls.length,
    };
  }

  /**
   * Set the baseline PnL snapshot for ROI tracking.
   */
  setBaselinePnl(agentId: string, pnl: number): void {
    if (!this.profitSnapshots.has(agentId)) {
      this.profitSnapshots.set(agentId, pnl);
    }
  }

  /**
   * Configure the allocation percentage for an agent.
   */
  setAllocationPct(agentId: string, pct: number): void {
    const budget = this.budgets.get(agentId) ?? {
      totalAllocatedUsd: 0,
      allocationPct: DEFAULT_INFERENCE_ALLOCATION_PCT,
    };
    budget.allocationPct = pct;
    this.budgets.set(agentId, budget);
  }

  // ─── Private ──────────────────────────────────────────────────────

  private getTotalSpent(agentId: string): number {
    const history = this.calls.get(agentId) ?? [];
    return history.reduce((sum, call) => sum + call.costUsd, 0);
  }
}
