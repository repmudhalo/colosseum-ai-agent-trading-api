import { v4 as uuid } from 'uuid';
import {
  ImprovementCycle,
  LoopStatus,
} from '../domain/improve/types.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';
import { InferenceBudgetService } from './inferenceBudgetService.js';
import { SelfImproveService } from './selfImproveService.js';

const INFERENCE_COST_PER_CYCLE = 0.05; // $0.05 per improvement cycle (AI inference)
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.7;

export class ImprovementLoopService {
  private readonly cycleHistory: Map<string, ImprovementCycle[]> = new Map();
  private readonly autoImproveConfig: Map<string, { enabled: boolean; intervalTicks: number }> = new Map();
  private readonly lastRunAt: Map<string, string> = new Map();

  constructor(
    private readonly store: StateStore,
    private readonly selfImproveService: SelfImproveService,
    private readonly inferenceBudgetService: InferenceBudgetService,
  ) {}

  /**
   * Run a full improvement cycle:
   * 1. Analyze recent performance
   * 2. Check inference budget
   * 3. Generate recommendations (deduct inference cost)
   * 4. Auto-apply top recommendation if confidence > threshold
   * 5. Log everything
   * 6. Return cycle report
   */
  async runImprovementCycle(agentId: string): Promise<ImprovementCycle> {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found.`);
    }

    // Set baseline PnL for ROI tracking on first cycle
    this.inferenceBudgetService.setBaselinePnl(agentId, agent.realizedPnlUsd);

    // Step 1: Analyze performance
    const analysis = this.selfImproveService.analyzePerformance(agentId);

    // Step 2: Check inference budget
    const budget = this.inferenceBudgetService.getInferenceBudget(agentId);

    // Step 3: Record inference cost (even if budget is insufficient, we still analyze)
    const inferenceCall = this.inferenceBudgetService.recordInferenceCall(
      agentId,
      INFERENCE_COST_PER_CYCLE,
      'self-improve-engine',
      'performance-analysis-and-recommendations',
    );

    const costCharged = inferenceCall ? INFERENCE_COST_PER_CYCLE : 0;

    // Step 3b: Generate recommendations
    const recommendations = this.selfImproveService.generateRecommendations(analysis);

    // Step 4: Auto-apply top recommendation if confidence > threshold
    let applied = null;
    if (recommendations.length > 0) {
      const topRec = recommendations.reduce((best, cur) =>
        cur.confidence > best.confidence ? cur : best,
      );

      if (topRec.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
        const record = await this.selfImproveService.applyRecommendation(agentId, topRec.id);
        if (record.applied) {
          applied = topRec;
        }
      }
    }

    // Step 5: Get updated budget after deduction
    const updatedBudget = this.inferenceBudgetService.getInferenceBudget(agentId);

    // Step 6: Create cycle record
    const cycle: ImprovementCycle = {
      id: uuid(),
      agentId,
      timestamp: isoNow(),
      analysis,
      recommendations,
      applied,
      inferenceCost: costCharged,
      budgetRemaining: updatedBudget.availableUsd,
    };

    const history = this.cycleHistory.get(agentId) ?? [];
    history.push(cycle);
    this.cycleHistory.set(agentId, history);
    this.lastRunAt.set(agentId, cycle.timestamp);

    eventBus.emit('improve.cycle', {
      agentId,
      cycleId: cycle.id,
      recommendationCount: recommendations.length,
      applied: applied?.type ?? null,
    });

    return cycle;
  }

  /**
   * Get the current loop status for an agent.
   */
  getLoopStatus(agentId: string): LoopStatus {
    const config = this.autoImproveConfig.get(agentId);
    const history = this.cycleHistory.get(agentId) ?? [];
    const budget = this.inferenceBudgetService.getInferenceBudget(agentId);
    const totalApplied = history.filter((c) => c.applied !== null).length;

    return {
      agentId,
      enabled: config?.enabled ?? false,
      intervalTicks: config?.intervalTicks ?? null,
      lastRunAt: this.lastRunAt.get(agentId) ?? null,
      cyclesCompleted: history.length,
      totalImprovementsApplied: totalApplied,
      budget,
    };
  }

  /**
   * Get all past improvement cycles for an agent.
   */
  getCycleHistory(agentId: string): ImprovementCycle[] {
    return this.cycleHistory.get(agentId) ?? [];
  }

  /**
   * Enable automatic improvement cycles on a tick interval.
   */
  enableAutoImprove(agentId: string, intervalTicks: number): LoopStatus {
    this.autoImproveConfig.set(agentId, { enabled: true, intervalTicks });
    return this.getLoopStatus(agentId);
  }

  /**
   * Disable automatic improvement.
   */
  disableAutoImprove(agentId: string): LoopStatus {
    this.autoImproveConfig.set(agentId, { enabled: false, intervalTicks: 0 });
    return this.getLoopStatus(agentId);
  }
}
