/**
 * Gas Optimization Service for Solana transactions.
 *
 * Provides priority fee estimation (low/medium/high/urgent tiers),
 * compute unit budgeting, transaction bundling, historical gas cost
 * tracking per agent, gas savings calculation, and Jito tip estimation
 * for MEV protection.
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Types ─────────────────────────────────────────────────────────────

export type PriorityTier = 'low' | 'medium' | 'high' | 'urgent';

export interface PriorityFeeEstimate {
  tier: PriorityTier;
  microLamportsPerCu: number;
  estimatedFeeLamports: number;
  estimatedFeeUsd: number;
  confidence: number;
  description: string;
}

export interface GasEstimateResponse {
  baseFeePerSignatureLamports: number;
  tiers: PriorityFeeEstimate[];
  networkCongestion: number;
  recentMedianFeeMicroLamports: number;
  solPriceUsd: number;
  estimatedAt: string;
}

export interface ComputeBudget {
  requestedUnits: number;
  optimizedUnits: number;
  savingsPercent: number;
  estimatedCostLamports: number;
}

export interface BundledTransaction {
  id: string;
  instructionCount: number;
  totalComputeUnits: number;
  estimatedFeeLamports: number;
  estimatedFeeUsd: number;
  savingsVsSeparateLamports: number;
  savingsVsSeparateUsd: number;
  createdAt: string;
}

export interface TransactionInstruction {
  programId: string;
  computeUnits?: number;
  description?: string;
}

export interface OptimizeRequest {
  agentId: string;
  instructions: TransactionInstruction[];
  priorityTier?: PriorityTier;
  enableJitoTip?: boolean;
  maxFeeLamports?: number;
}

export interface OptimizeResponse {
  bundle: BundledTransaction;
  computeBudget: ComputeBudget;
  priorityFee: PriorityFeeEstimate;
  jitoTip: JitoTipEstimate | null;
  totalCostLamports: number;
  totalCostUsd: number;
  optimizationNotes: string[];
}

export interface GasCostRecord {
  id: string;
  agentId: string;
  transactionId: string;
  feeLamports: number;
  feeUsd: number;
  computeUnitsUsed: number;
  priorityTier: PriorityTier;
  instructionCount: number;
  jitoTipLamports: number;
  timestamp: string;
}

export interface GasHistoryResponse {
  agentId: string;
  records: GasCostRecord[];
  summary: {
    totalTransactions: number;
    totalFeeLamports: number;
    totalFeeUsd: number;
    avgFeeLamports: number;
    avgFeeUsd: number;
    totalComputeUnits: number;
    avgComputeUnits: number;
    tierBreakdown: Record<PriorityTier, number>;
  };
}

export interface JitoTipEstimate {
  tipLamports: number;
  tipUsd: number;
  percentile: number;
  description: string;
}

export interface GasSavingsReport {
  agentId: string;
  totalTransactions: number;
  naiveTotalFeeLamports: number;
  naiveTotalFeeUsd: number;
  optimizedTotalFeeLamports: number;
  optimizedTotalFeeUsd: number;
  savingsLamports: number;
  savingsUsd: number;
  savingsPercent: number;
  avgSavingsPerTxLamports: number;
  avgSavingsPerTxUsd: number;
  computeUnitsSaved: number;
  bundleSavings: number;
  generatedAt: string;
}

// ─── Constants ─────────────────────────────────────────────────────────

const BASE_FEE_PER_SIGNATURE_LAMPORTS = 5000;
const DEFAULT_COMPUTE_UNITS_PER_IX = 200_000;
const MAX_COMPUTE_UNITS_PER_TX = 1_400_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Micro-lamports per compute unit by priority tier (baseline, modulated by congestion). */
const TIER_BASE_RATES: Record<PriorityTier, { base: number; confidence: number; description: string }> = {
  low: { base: 100, confidence: 0.7, description: 'Economy — may be delayed under congestion' },
  medium: { base: 1_000, confidence: 0.85, description: 'Standard — reliable for most workloads' },
  high: { base: 10_000, confidence: 0.95, description: 'Fast — prioritized inclusion' },
  urgent: { base: 100_000, confidence: 0.99, description: 'Urgent — near-guaranteed next-slot inclusion' },
};

const TIERS_ORDER: PriorityTier[] = ['low', 'medium', 'high', 'urgent'];

// ─── Service ───────────────────────────────────────────────────────────

export class GasOptimizationService {
  private gasHistory: Map<string, GasCostRecord[]> = new Map();
  private bundleCounter = 0;
  private recordCounter = 0;

  /** Simulated network congestion level 0-1. */
  private networkCongestion = 0.35;

  constructor(private readonly store: StateStore) {}

  // ─── Priority Fee Estimation ──────────────────────────────────────

  /**
   * Estimate priority fees across all tiers given current network conditions.
   */
  estimatePriorityFees(): GasEstimateResponse {
    const solPriceUsd = this.getSolPrice();
    const congestion = this.networkCongestion;
    const congestionMultiplier = 1 + congestion * 2; // 1x at 0%, 3x at 100%

    const tiers: PriorityFeeEstimate[] = TIERS_ORDER.map((tier) => {
      const { base, confidence, description } = TIER_BASE_RATES[tier];
      const microLamportsPerCu = Math.round(base * congestionMultiplier);
      // Estimate for a typical 200k CU transaction
      const estimatedFeeLamports = BASE_FEE_PER_SIGNATURE_LAMPORTS
        + Math.round((microLamportsPerCu * DEFAULT_COMPUTE_UNITS_PER_IX) / 1_000_000);
      const estimatedFeeUsd = Number(((estimatedFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8));

      return {
        tier,
        microLamportsPerCu,
        estimatedFeeLamports,
        estimatedFeeUsd,
        confidence,
        description,
      };
    });

    const medianFee = tiers[1].microLamportsPerCu; // medium tier as representative

    return {
      baseFeePerSignatureLamports: BASE_FEE_PER_SIGNATURE_LAMPORTS,
      tiers,
      networkCongestion: Number(congestion.toFixed(2)),
      recentMedianFeeMicroLamports: medianFee,
      solPriceUsd,
      estimatedAt: new Date().toISOString(),
    };
  }

  // ─── Compute Unit Budgeting ───────────────────────────────────────

  /**
   * Calculate optimized compute budget for a set of instructions.
   */
  computeBudget(instructions: TransactionInstruction[], priorityTier: PriorityTier = 'medium'): ComputeBudget {
    const requestedUnits = instructions.reduce(
      (sum, ix) => sum + (ix.computeUnits ?? DEFAULT_COMPUTE_UNITS_PER_IX),
      0,
    );

    // Optimization: add 10% headroom but trim over-allocation
    const optimizedUnits = Math.min(
      Math.ceil(requestedUnits * 0.8), // 20% reduction from naive allocation
      MAX_COMPUTE_UNITS_PER_TX,
    );

    const savingsPercent = requestedUnits > 0
      ? Number((((requestedUnits - optimizedUnits) / requestedUnits) * 100).toFixed(1))
      : 0;

    const congestionMultiplier = 1 + this.networkCongestion * 2;
    const microLamportsPerCu = TIER_BASE_RATES[priorityTier].base * congestionMultiplier;
    const estimatedCostLamports = BASE_FEE_PER_SIGNATURE_LAMPORTS
      + Math.round((microLamportsPerCu * optimizedUnits) / 1_000_000);

    return {
      requestedUnits,
      optimizedUnits,
      savingsPercent,
      estimatedCostLamports,
    };
  }

  // ─── Transaction Bundling ─────────────────────────────────────────

  /**
   * Bundle multiple instructions into an optimized single transaction.
   */
  bundleInstructions(
    instructions: TransactionInstruction[],
    priorityTier: PriorityTier = 'medium',
  ): BundledTransaction {
    const solPriceUsd = this.getSolPrice();
    const budget = this.computeBudget(instructions, priorityTier);

    // Cost if each instruction were a separate transaction
    const separateCostLamports = instructions.length * (BASE_FEE_PER_SIGNATURE_LAMPORTS + budget.estimatedCostLamports);

    const bundledFeeLamports = budget.estimatedCostLamports;
    const savingsLamports = Math.max(0, separateCostLamports - bundledFeeLamports);

    this.bundleCounter += 1;
    const id = `bundle-${this.bundleCounter}-${Date.now().toString(36)}`;

    return {
      id,
      instructionCount: instructions.length,
      totalComputeUnits: budget.optimizedUnits,
      estimatedFeeLamports: bundledFeeLamports,
      estimatedFeeUsd: Number(((bundledFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      savingsVsSeparateLamports: savingsLamports,
      savingsVsSeparateUsd: Number(((savingsLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Transaction Optimization (full pipeline) ────────────────────

  /**
   * Full optimization of a transaction: budget, priority fee, bundling, Jito tip.
   */
  optimizeTransaction(request: OptimizeRequest): OptimizeResponse {
    const { agentId, instructions, priorityTier = 'medium', enableJitoTip = false, maxFeeLamports } = request;
    const solPriceUsd = this.getSolPrice();

    const bundle = this.bundleInstructions(instructions, priorityTier);
    const budget = this.computeBudget(instructions, priorityTier);

    const congestionMultiplier = 1 + this.networkCongestion * 2;
    const tierInfo = TIER_BASE_RATES[priorityTier];
    const microLamportsPerCu = Math.round(tierInfo.base * congestionMultiplier);
    const priorityFeeLamports = Math.round((microLamportsPerCu * budget.optimizedUnits) / 1_000_000);

    const priorityFee: PriorityFeeEstimate = {
      tier: priorityTier,
      microLamportsPerCu,
      estimatedFeeLamports: priorityFeeLamports,
      estimatedFeeUsd: Number(((priorityFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      confidence: tierInfo.confidence,
      description: tierInfo.description,
    };

    const jitoTip = enableJitoTip ? this.estimateJitoTip(priorityTier) : null;

    let totalCostLamports = BASE_FEE_PER_SIGNATURE_LAMPORTS + priorityFeeLamports;
    if (jitoTip) {
      totalCostLamports += jitoTip.tipLamports;
    }

    const optimizationNotes: string[] = [];
    if (budget.savingsPercent > 0) {
      optimizationNotes.push(`Compute units reduced by ${budget.savingsPercent}% via budget optimization`);
    }
    if (instructions.length > 1) {
      optimizationNotes.push(`${instructions.length} instructions bundled into single transaction`);
    }
    if (jitoTip) {
      optimizationNotes.push(`Jito tip of ${jitoTip.tipLamports} lamports added for MEV protection`);
    }
    if (maxFeeLamports && totalCostLamports > maxFeeLamports) {
      optimizationNotes.push(`Warning: estimated cost ${totalCostLamports} exceeds max fee cap ${maxFeeLamports}`);
    }

    const totalCostUsd = Number(((totalCostLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8));

    // Record cost for history tracking
    this.recordGasCost(agentId, {
      transactionId: bundle.id,
      feeLamports: totalCostLamports,
      feeUsd: totalCostUsd,
      computeUnitsUsed: budget.optimizedUnits,
      priorityTier,
      instructionCount: instructions.length,
      jitoTipLamports: jitoTip?.tipLamports ?? 0,
    });

    return {
      bundle,
      computeBudget: budget,
      priorityFee,
      jitoTip,
      totalCostLamports,
      totalCostUsd,
      optimizationNotes,
    };
  }

  // ─── Jito Tip Estimation ──────────────────────────────────────────

  /**
   * Estimate Jito tip for MEV protection based on priority tier.
   */
  estimateJitoTip(priorityTier: PriorityTier = 'medium'): JitoTipEstimate {
    const solPriceUsd = this.getSolPrice();

    // Jito tip percentiles (in lamports) based on priority
    const tipByTier: Record<PriorityTier, { lamports: number; percentile: number; description: string }> = {
      low: { lamports: 1_000, percentile: 25, description: 'Minimum Jito tip — may not win auction' },
      medium: { lamports: 10_000, percentile: 50, description: 'Median Jito tip — reasonable inclusion chance' },
      high: { lamports: 100_000, percentile: 75, description: 'Competitive Jito tip — strong inclusion likelihood' },
      urgent: { lamports: 500_000, percentile: 95, description: 'Premium Jito tip — near-guaranteed bundle inclusion' },
    };

    const tipInfo = tipByTier[priorityTier];
    const congestionMultiplier = 1 + this.networkCongestion;
    const tipLamports = Math.round(tipInfo.lamports * congestionMultiplier);
    const tipUsd = Number(((tipLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8));

    return {
      tipLamports,
      tipUsd,
      percentile: tipInfo.percentile,
      description: tipInfo.description,
    };
  }

  // ─── Historical Gas Cost Tracking ─────────────────────────────────

  /**
   * Get gas cost history for an agent.
   */
  getGasHistory(agentId: string, limit = 50): GasHistoryResponse {
    const records = (this.gasHistory.get(agentId) ?? []).slice(-limit);

    const totalTransactions = records.length;
    const totalFeeLamports = records.reduce((s, r) => s + r.feeLamports, 0);
    const totalFeeUsd = records.reduce((s, r) => s + r.feeUsd, 0);
    const totalComputeUnits = records.reduce((s, r) => s + r.computeUnitsUsed, 0);

    const tierBreakdown: Record<PriorityTier, number> = { low: 0, medium: 0, high: 0, urgent: 0 };
    for (const r of records) {
      tierBreakdown[r.priorityTier] += 1;
    }

    return {
      agentId,
      records,
      summary: {
        totalTransactions,
        totalFeeLamports,
        totalFeeUsd: Number(totalFeeUsd.toFixed(8)),
        avgFeeLamports: totalTransactions > 0 ? Math.round(totalFeeLamports / totalTransactions) : 0,
        avgFeeUsd: totalTransactions > 0 ? Number((totalFeeUsd / totalTransactions).toFixed(8)) : 0,
        totalComputeUnits,
        avgComputeUnits: totalTransactions > 0 ? Math.round(totalComputeUnits / totalTransactions) : 0,
        tierBreakdown,
      },
    };
  }

  // ─── Gas Savings Calculator ───────────────────────────────────────

  /**
   * Calculate how much an agent saved vs. a naive (unoptimized) approach.
   */
  getSavingsReport(agentId: string): GasSavingsReport {
    const records = this.gasHistory.get(agentId) ?? [];
    const solPriceUsd = this.getSolPrice();

    let optimizedTotalFeeLamports = 0;
    let naiveTotalFeeLamports = 0;
    let computeUnitsSaved = 0;
    let bundleSavings = 0;

    for (const record of records) {
      optimizedTotalFeeLamports += record.feeLamports;

      // Naive approach: full 200k CU per instruction, each instruction as separate tx
      const naiveCuPerIx = DEFAULT_COMPUTE_UNITS_PER_IX;
      const naiveTotalCu = naiveCuPerIx * record.instructionCount;
      const congestionMultiplier = 1 + this.networkCongestion * 2;
      const microLamportsPerCu = TIER_BASE_RATES[record.priorityTier].base * congestionMultiplier;
      const naivePriorityFee = Math.round((microLamportsPerCu * naiveTotalCu) / 1_000_000);
      const naiveBaseFees = record.instructionCount * BASE_FEE_PER_SIGNATURE_LAMPORTS;
      const naiveFee = naiveBaseFees + naivePriorityFee + record.jitoTipLamports;

      naiveTotalFeeLamports += naiveFee;

      // CU savings
      const naiveCu = naiveCuPerIx * record.instructionCount;
      computeUnitsSaved += Math.max(0, naiveCu - record.computeUnitsUsed);

      // Bundle savings (extra base fees avoided)
      if (record.instructionCount > 1) {
        bundleSavings += (record.instructionCount - 1) * BASE_FEE_PER_SIGNATURE_LAMPORTS;
      }
    }

    const savingsLamports = Math.max(0, naiveTotalFeeLamports - optimizedTotalFeeLamports);
    const savingsPercent = naiveTotalFeeLamports > 0
      ? Number(((savingsLamports / naiveTotalFeeLamports) * 100).toFixed(1))
      : 0;

    const totalTransactions = records.length;

    return {
      agentId,
      totalTransactions,
      naiveTotalFeeLamports,
      naiveTotalFeeUsd: Number(((naiveTotalFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      optimizedTotalFeeLamports,
      optimizedTotalFeeUsd: Number(((optimizedTotalFeeLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      savingsLamports,
      savingsUsd: Number(((savingsLamports / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8)),
      savingsPercent,
      avgSavingsPerTxLamports: totalTransactions > 0 ? Math.round(savingsLamports / totalTransactions) : 0,
      avgSavingsPerTxUsd: totalTransactions > 0
        ? Number((((savingsLamports / totalTransactions) / LAMPORTS_PER_SOL) * solPriceUsd).toFixed(8))
        : 0,
      computeUnitsSaved,
      bundleSavings,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Network congestion setter (for testing / simulation) ─────────

  /**
   * Set simulated network congestion (0-1).
   */
  setNetworkCongestion(level: number): void {
    this.networkCongestion = Math.max(0, Math.min(1, level));
  }

  getNetworkCongestion(): number {
    return this.networkCongestion;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private getSolPrice(): number {
    const state = this.store.snapshot();
    return state.marketPricesUsd['SOL'] ?? 100;
  }

  private recordGasCost(
    agentId: string,
    data: Omit<GasCostRecord, 'id' | 'agentId' | 'timestamp'>,
  ): void {
    this.recordCounter += 1;
    const record: GasCostRecord = {
      id: `gas-${this.recordCounter}-${Date.now().toString(36)}`,
      agentId,
      ...data,
      timestamp: new Date().toISOString(),
    };

    if (!this.gasHistory.has(agentId)) {
      this.gasHistory.set(agentId, []);
    }

    const records = this.gasHistory.get(agentId)!;
    records.push(record);

    // Keep bounded
    if (records.length > 10_000) {
      this.gasHistory.set(agentId, records.slice(-5_000));
    }
  }
}
