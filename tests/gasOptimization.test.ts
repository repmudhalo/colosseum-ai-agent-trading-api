import { describe, expect, it, vi } from 'vitest';
import {
  GasOptimizationService,
  PriorityTier,
  TransactionInstruction,
} from '../src/services/gasOptimizationService.js';
import { AppState } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeService(solPrice = 100): GasOptimizationService {
  const state = createDefaultState();
  state.marketPricesUsd['SOL'] = solPrice;
  return new GasOptimizationService(createMockStore(state));
}

function sampleInstructions(count = 3): TransactionInstruction[] {
  return Array.from({ length: count }, (_, i) => ({
    programId: `program-${i}`,
    computeUnits: 100_000,
    description: `Instruction ${i}`,
  }));
}

// ─── Priority Fee Estimation ──────────────────────────────────────────

describe('GasOptimizationService — estimatePriorityFees', () => {
  it('returns four tiers in ascending order of cost', () => {
    const svc = makeService();
    const result = svc.estimatePriorityFees();

    expect(result.tiers).toHaveLength(4);
    expect(result.tiers.map((t) => t.tier)).toEqual(['low', 'medium', 'high', 'urgent']);

    // Each tier should cost more than the previous
    for (let i = 1; i < result.tiers.length; i++) {
      expect(result.tiers[i].microLamportsPerCu).toBeGreaterThan(result.tiers[i - 1].microLamportsPerCu);
    }
  });

  it('includes valid metadata fields', () => {
    const svc = makeService();
    const result = svc.estimatePriorityFees();

    expect(result.baseFeePerSignatureLamports).toBe(5000);
    expect(result.networkCongestion).toBeGreaterThanOrEqual(0);
    expect(result.networkCongestion).toBeLessThanOrEqual(1);
    expect(result.solPriceUsd).toBeGreaterThan(0);
    expect(result.estimatedAt).toBeDefined();
    expect(result.recentMedianFeeMicroLamports).toBeGreaterThan(0);
  });

  it('scales fees with network congestion', () => {
    const svc = makeService();
    svc.setNetworkCongestion(0);
    const lowCongestion = svc.estimatePriorityFees();

    svc.setNetworkCongestion(1);
    const highCongestion = svc.estimatePriorityFees();

    // High congestion should produce higher fees
    expect(highCongestion.tiers[1].microLamportsPerCu).toBeGreaterThan(
      lowCongestion.tiers[1].microLamportsPerCu,
    );
  });

  it('reflects the SOL price in USD estimates', () => {
    const svc50 = makeService(50);
    const svc200 = makeService(200);

    const est50 = svc50.estimatePriorityFees();
    const est200 = svc200.estimatePriorityFees();

    // Same lamport fee, but higher USD at higher SOL price
    expect(est200.tiers[0].estimatedFeeUsd).toBeGreaterThan(est50.tiers[0].estimatedFeeUsd);
  });
});

// ─── Compute Unit Budgeting ───────────────────────────────────────────

describe('GasOptimizationService — computeBudget', () => {
  it('reduces compute units from naive allocation', () => {
    const svc = makeService();
    const instructions = sampleInstructions(3);
    const budget = svc.computeBudget(instructions);

    // 3 instructions × 100k CU = 300k requested
    expect(budget.requestedUnits).toBe(300_000);
    // Optimized should be less than requested
    expect(budget.optimizedUnits).toBeLessThan(budget.requestedUnits);
    expect(budget.savingsPercent).toBeGreaterThan(0);
    expect(budget.estimatedCostLamports).toBeGreaterThan(0);
  });

  it('uses default CU when instruction has no computeUnits specified', () => {
    const svc = makeService();
    const instructions: TransactionInstruction[] = [
      { programId: 'prog-1' },
    ];
    const budget = svc.computeBudget(instructions);

    // Default is 200k per instruction
    expect(budget.requestedUnits).toBe(200_000);
  });

  it('caps at max compute units per transaction', () => {
    const svc = makeService();
    // 10 instructions × 200k = 2M CU (exceeds 1.4M cap)
    const instructions: TransactionInstruction[] = Array.from({ length: 10 }, (_, i) => ({
      programId: `prog-${i}`,
      computeUnits: 200_000,
    }));

    const budget = svc.computeBudget(instructions);
    expect(budget.optimizedUnits).toBeLessThanOrEqual(1_400_000);
  });
});

// ─── Transaction Bundling ─────────────────────────────────────────────

describe('GasOptimizationService — bundleInstructions', () => {
  it('bundles multiple instructions and shows savings', () => {
    const svc = makeService();
    const instructions = sampleInstructions(5);
    const bundle = svc.bundleInstructions(instructions, 'medium');

    expect(bundle.instructionCount).toBe(5);
    expect(bundle.totalComputeUnits).toBeGreaterThan(0);
    expect(bundle.estimatedFeeLamports).toBeGreaterThan(0);
    expect(bundle.savingsVsSeparateLamports).toBeGreaterThanOrEqual(0);
    expect(bundle.id).toContain('bundle-');
    expect(bundle.createdAt).toBeDefined();
  });

  it('produces unique bundle IDs', () => {
    const svc = makeService();
    const ix = sampleInstructions(2);
    const b1 = svc.bundleInstructions(ix);
    const b2 = svc.bundleInstructions(ix);
    expect(b1.id).not.toBe(b2.id);
  });
});

// ─── Full Optimize Pipeline ───────────────────────────────────────────

describe('GasOptimizationService — optimizeTransaction', () => {
  it('returns complete optimization result', () => {
    const svc = makeService();
    const result = svc.optimizeTransaction({
      agentId: 'agent-1',
      instructions: sampleInstructions(3),
      priorityTier: 'high',
      enableJitoTip: true,
    });

    expect(result.bundle).toBeDefined();
    expect(result.computeBudget).toBeDefined();
    expect(result.priorityFee.tier).toBe('high');
    expect(result.jitoTip).not.toBeNull();
    expect(result.totalCostLamports).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.optimizationNotes.length).toBeGreaterThan(0);
  });

  it('includes Jito tip in total cost when enabled', () => {
    const svc = makeService();

    const withJito = svc.optimizeTransaction({
      agentId: 'agent-1',
      instructions: sampleInstructions(2),
      priorityTier: 'medium',
      enableJitoTip: true,
    });

    const withoutJito = svc.optimizeTransaction({
      agentId: 'agent-2',
      instructions: sampleInstructions(2),
      priorityTier: 'medium',
      enableJitoTip: false,
    });

    expect(withJito.jitoTip).not.toBeNull();
    expect(withoutJito.jitoTip).toBeNull();
    expect(withJito.totalCostLamports).toBeGreaterThan(withoutJito.totalCostLamports);
  });

  it('records gas cost for history tracking', () => {
    const svc = makeService();
    svc.optimizeTransaction({
      agentId: 'agent-track',
      instructions: sampleInstructions(2),
    });

    const history = svc.getGasHistory('agent-track');
    expect(history.records).toHaveLength(1);
    expect(history.records[0].agentId).toBe('agent-track');
  });

  it('adds warning note when maxFeeLamports exceeded', () => {
    const svc = makeService();
    const result = svc.optimizeTransaction({
      agentId: 'agent-cap',
      instructions: sampleInstructions(3),
      priorityTier: 'urgent',
      enableJitoTip: true,
      maxFeeLamports: 1, // impossibly low cap
    });

    const hasWarning = result.optimizationNotes.some((n) => n.includes('Warning'));
    expect(hasWarning).toBe(true);
  });
});

// ─── Jito Tip Estimation ──────────────────────────────────────────────

describe('GasOptimizationService — estimateJitoTip', () => {
  it('returns higher tips for higher priority tiers', () => {
    const svc = makeService();
    const low = svc.estimateJitoTip('low');
    const urgent = svc.estimateJitoTip('urgent');

    expect(urgent.tipLamports).toBeGreaterThan(low.tipLamports);
    expect(urgent.percentile).toBeGreaterThan(low.percentile);
  });

  it('includes description and USD value', () => {
    const svc = makeService();
    const tip = svc.estimateJitoTip('medium');

    expect(tip.description).toBeDefined();
    expect(tip.tipUsd).toBeGreaterThan(0);
    expect(tip.tipLamports).toBeGreaterThan(0);
  });

  it('scales Jito tips with congestion', () => {
    const svc = makeService();
    svc.setNetworkCongestion(0);
    const lowCongestionTip = svc.estimateJitoTip('medium');

    svc.setNetworkCongestion(1);
    const highCongestionTip = svc.estimateJitoTip('medium');

    expect(highCongestionTip.tipLamports).toBeGreaterThan(lowCongestionTip.tipLamports);
  });
});

// ─── Historical Gas Cost Tracking ─────────────────────────────────────

describe('GasOptimizationService — getGasHistory', () => {
  it('returns empty history for unknown agent', () => {
    const svc = makeService();
    const history = svc.getGasHistory('nonexistent');

    expect(history.agentId).toBe('nonexistent');
    expect(history.records).toHaveLength(0);
    expect(history.summary.totalTransactions).toBe(0);
    expect(history.summary.avgFeeLamports).toBe(0);
  });

  it('accumulates records across multiple optimizations', () => {
    const svc = makeService();
    const agentId = 'agent-multi';

    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(2) });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(3) });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(1) });

    const history = svc.getGasHistory(agentId);
    expect(history.records).toHaveLength(3);
    expect(history.summary.totalTransactions).toBe(3);
    expect(history.summary.totalFeeLamports).toBeGreaterThan(0);
    expect(history.summary.avgFeeLamports).toBeGreaterThan(0);
  });

  it('respects the limit parameter', () => {
    const svc = makeService();
    const agentId = 'agent-limit';

    for (let i = 0; i < 10; i++) {
      svc.optimizeTransaction({ agentId, instructions: sampleInstructions(1) });
    }

    const limited = svc.getGasHistory(agentId, 3);
    expect(limited.records).toHaveLength(3);
  });

  it('tracks tier breakdown in summary', () => {
    const svc = makeService();
    const agentId = 'agent-tiers';

    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(1), priorityTier: 'low' });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(1), priorityTier: 'low' });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(1), priorityTier: 'high' });

    const history = svc.getGasHistory(agentId);
    expect(history.summary.tierBreakdown.low).toBe(2);
    expect(history.summary.tierBreakdown.high).toBe(1);
    expect(history.summary.tierBreakdown.medium).toBe(0);
  });
});

// ─── Gas Savings Calculator ───────────────────────────────────────────

describe('GasOptimizationService — getSavingsReport', () => {
  it('returns zero savings for agent with no history', () => {
    const svc = makeService();
    const report = svc.getSavingsReport('empty-agent');

    expect(report.totalTransactions).toBe(0);
    expect(report.savingsLamports).toBe(0);
    expect(report.savingsPercent).toBe(0);
    expect(report.computeUnitsSaved).toBe(0);
  });

  it('computes positive savings vs naive approach', () => {
    const svc = makeService();
    const agentId = 'agent-savings';

    // Run several multi-instruction optimizations
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(4), priorityTier: 'medium' });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(3), priorityTier: 'high' });

    const report = svc.getSavingsReport(agentId);
    expect(report.totalTransactions).toBe(2);
    expect(report.naiveTotalFeeLamports).toBeGreaterThan(report.optimizedTotalFeeLamports);
    expect(report.savingsLamports).toBeGreaterThan(0);
    expect(report.savingsPercent).toBeGreaterThan(0);
    expect(report.computeUnitsSaved).toBeGreaterThan(0);
    expect(report.bundleSavings).toBeGreaterThan(0);
    expect(report.generatedAt).toBeDefined();
  });

  it('reports USD savings correctly', () => {
    const svc = makeService(150); // SOL at $150
    const agentId = 'agent-usd';

    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(5) });

    const report = svc.getSavingsReport(agentId);
    expect(report.savingsUsd).toBeGreaterThanOrEqual(0);
    expect(report.naiveTotalFeeUsd).toBeGreaterThan(0);
    expect(report.optimizedTotalFeeUsd).toBeGreaterThan(0);
  });

  it('tracks average savings per transaction', () => {
    const svc = makeService();
    const agentId = 'agent-avg';

    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(3) });
    svc.optimizeTransaction({ agentId, instructions: sampleInstructions(3) });

    const report = svc.getSavingsReport(agentId);
    expect(report.avgSavingsPerTxLamports).toBeGreaterThanOrEqual(0);
    if (report.totalTransactions > 0 && report.savingsLamports > 0) {
      expect(report.avgSavingsPerTxLamports).toBe(
        Math.round(report.savingsLamports / report.totalTransactions),
      );
    }
  });
});

// ─── Network Congestion ───────────────────────────────────────────────

describe('GasOptimizationService — network congestion', () => {
  it('clamps congestion between 0 and 1', () => {
    const svc = makeService();
    svc.setNetworkCongestion(-0.5);
    expect(svc.getNetworkCongestion()).toBe(0);

    svc.setNetworkCongestion(2.5);
    expect(svc.getNetworkCongestion()).toBe(1);

    svc.setNetworkCongestion(0.42);
    expect(svc.getNetworkCongestion()).toBe(0.42);
  });
});
