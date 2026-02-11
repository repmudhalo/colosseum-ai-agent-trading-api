import { describe, expect, it, vi } from 'vitest';
import { analyzeSandwichRisk, suggestProtection } from '../src/domain/mev/mevProtection.js';
import { MevProtectionService } from '../src/services/mevProtectionService.js';
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

describe('MEV Protection — analyzeSandwichRisk', () => {
  it('returns low risk for small orders in deep pools', () => {
    const report = analyzeSandwichRisk({
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 100,
      poolLiquidityUsd: 1_000_000,
      slippageTolerance: 0.005,
      recentPoolTxCount: 10,
    });

    expect(report.riskScore).toBeLessThan(25);
    expect(report.riskLevel).toBe('low');
    expect(report.factors.length).toBe(3);
    expect(report.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(report.analyzedAt).toBeDefined();
  });

  it('returns high risk for large orders in shallow pools with high slippage', () => {
    const report = analyzeSandwichRisk({
      symbol: 'BONK',
      side: 'buy',
      notionalUsd: 50_000,
      poolLiquidityUsd: 100_000,
      slippageTolerance: 0.05,
      recentPoolTxCount: 200,
    });

    expect(report.riskScore).toBeGreaterThanOrEqual(50);
    expect(['high', 'critical']).toContain(report.riskLevel);
    expect(report.mitigations.length).toBeGreaterThan(0);
    expect(report.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('uses default values when optional fields omitted', () => {
    const report = analyzeSandwichRisk({
      symbol: 'SOL',
      side: 'sell',
      notionalUsd: 1000,
    });

    expect(report.riskScore).toBeGreaterThanOrEqual(0);
    expect(report.riskScore).toBeLessThanOrEqual(100);
    expect(report.factors.length).toBe(3);
  });

  it('caps risk score at 100', () => {
    const report = analyzeSandwichRisk({
      symbol: 'BONK',
      side: 'buy',
      notionalUsd: 500_000,
      poolLiquidityUsd: 10_000,
      slippageTolerance: 0.1,
      recentPoolTxCount: 500,
    });

    expect(report.riskScore).toBeLessThanOrEqual(100);
  });
});

describe('MEV Protection — suggestProtection', () => {
  it('returns no mitigations for very low risk', () => {
    const mitigations = suggestProtection(10, 100);
    expect(mitigations.length).toBe(0);
  });

  it('suggests private RPC for moderate risk', () => {
    const mitigations = suggestProtection(30, 1000);
    expect(mitigations.some((m) => m.strategy === 'use_private_rpc')).toBe(true);
  });

  it('suggests order splitting for large orders with moderate risk', () => {
    const mitigations = suggestProtection(40, 10_000);
    expect(mitigations.some((m) => m.strategy === 'split_orders')).toBe(true);
  });

  it('suggests TWAP for very large high-risk orders', () => {
    const mitigations = suggestProtection(60, 15_000);
    expect(mitigations.some((m) => m.strategy === 'use_twap')).toBe(true);
  });
});

describe('MevProtectionService', () => {
  function setup() {
    const state = createDefaultState();
    const store = createMockStore(state);
    const service = new MevProtectionService(store);
    return { service };
  }

  it('analyzes trade and returns report', () => {
    const { service } = setup();
    const report = service.analyze({
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 5000,
      slippageTolerance: 0.02,
    });

    expect(report.riskScore).toBeGreaterThanOrEqual(0);
    expect(report.riskLevel).toBeDefined();
    expect(report.factors.length).toBe(3);
  });

  it('tracks aggregate statistics', () => {
    const { service } = setup();
    service.analyze({ symbol: 'SOL', side: 'buy', notionalUsd: 100, poolLiquidityUsd: 1_000_000, slippageTolerance: 0.005, recentPoolTxCount: 5 });
    service.analyze({ symbol: 'BONK', side: 'sell', notionalUsd: 50_000, poolLiquidityUsd: 50_000, slippageTolerance: 0.05, recentPoolTxCount: 200 });

    const stats = service.getMevStats();
    expect(stats.totalAnalyzed).toBe(2);
    expect(stats.averageRiskScore).toBeGreaterThan(0);
    expect(stats.riskDistribution.low + stats.riskDistribution.medium + stats.riskDistribution.high + stats.riskDistribution.critical).toBe(2);
    expect(stats.topMitigations.length).toBeGreaterThan(0);
  });

  it('returns empty stats when no analyses performed', () => {
    const { service } = setup();
    const stats = service.getMevStats();
    expect(stats.totalAnalyzed).toBe(0);
    expect(stats.averageRiskScore).toBe(0);
  });

  it('enriches intent with market data when pool liquidity not provided', () => {
    const { service } = setup();
    // State has SOL at $100, so pool liquidity = 100 * 10,000 = 1,000,000
    const report = service.analyze({
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 500,
    });

    // Should get a relatively low score since 500 / 1M is tiny
    expect(report.riskScore).toBeLessThan(50);
  });
});
