/**
 * Types for the self-improving autonomous trading system.
 * AI inference flywheel: profits → fund AI calls → analyze performance → auto-tune → more profits.
 */

export interface Pattern {
  type: 'time-of-day' | 'symbol' | 'size' | 'strategy' | 'drawdown';
  description: string;
  metric: number;
}

export interface PerformanceAnalysis {
  agentId: string;
  analyzedAt: string;
  executionCount: number;
  winRate: number;
  avgReturnPct: number;
  bestStrategy: string;
  worstStrategy: string;
  riskRejectionRate: number;
  patterns: Pattern[];
}

export type RecommendationType =
  | 'strategy-switch'
  | 'risk-adjustment'
  | 'timing-optimization'
  | 'position-sizing';

export interface Recommendation {
  id: string;
  type: RecommendationType;
  description: string;
  confidence: number;
  expectedImpactPct: number;
  parameters: Record<string, unknown>;
}

export interface ImprovementRecord {
  id: string;
  agentId: string;
  timestamp: string;
  recommendation: Recommendation;
  applied: boolean;
  resultPnlBefore: number;
  resultPnlAfter: number | null;
}

export interface ImprovementCycle {
  id: string;
  agentId: string;
  timestamp: string;
  analysis: PerformanceAnalysis;
  recommendations: Recommendation[];
  applied: Recommendation | null;
  inferenceCost: number;
  budgetRemaining: number;
}

export interface InferenceCall {
  id: string;
  agentId: string;
  timestamp: string;
  provider: string;
  purpose: string;
  costUsd: number;
}

export interface InferenceBudget {
  agentId: string;
  totalAllocatedUsd: number;
  totalSpentUsd: number;
  availableUsd: number;
  inferenceAllocationPct: number;
}

export interface InferenceROI {
  agentId: string;
  totalInferenceSpentUsd: number;
  profitImprovementUsd: number;
  roi: number;
  cyclesRun: number;
}

export interface LoopStatus {
  agentId: string;
  enabled: boolean;
  intervalTicks: number | null;
  lastRunAt: string | null;
  cyclesCompleted: number;
  totalImprovementsApplied: number;
  budget: InferenceBudget;
}
