import { describe, expect, it, beforeEach } from 'vitest';
import {
  BridgeMonitorService,
  BridgeProvider,
  ChainId,
} from '../src/services/bridgeMonitorService.js';

describe('BridgeMonitorService', () => {
  let service: BridgeMonitorService;

  beforeEach(() => {
    service = new BridgeMonitorService();
  });

  // ─── Bridge Health Monitoring ─────────────────────────────────────────

  it('returns health status for all bridge providers', () => {
    const health = service.getAllBridgeHealth();
    expect(health).toHaveLength(3);

    const providers = health.map((h) => h.provider).sort();
    expect(providers).toEqual(['allbridge', 'debridge', 'wormhole']);

    for (const h of health) {
      expect(h.status).toMatch(/^(healthy|degraded|down)$/);
      expect(h.uptimePct).toBeGreaterThan(0);
      expect(h.avgTransferTimeMs).toBeGreaterThan(0);
      expect(h.checkedAt).toBeDefined();
    }
  });

  it('returns health for a single provider', () => {
    const health = service.getBridgeHealth('wormhole');
    expect(health).not.toBeNull();
    expect(health!.provider).toBe('wormhole');
    expect(health!.uptimePct).toBeGreaterThan(90);
  });

  it('returns null for unknown provider health lookup', () => {
    const health = service.getBridgeHealth('unknown-bridge' as BridgeProvider);
    expect(health).toBeNull();
  });

  // ─── Bridge Transaction Tracking ──────────────────────────────────────

  it('tracks a new bridge transaction', () => {
    const tx = service.trackTransaction({
      provider: 'wormhole',
      sourceTxHash: '0xabc123',
      sourceChain: 'solana',
      destChain: 'ethereum',
      token: 'USDC',
      amountUsd: 1000,
      agentId: 'agent-1',
    });

    expect(tx.id).toBeDefined();
    expect(tx.provider).toBe('wormhole');
    expect(tx.sourceChain).toBe('solana');
    expect(tx.destChain).toBe('ethereum');
    expect(tx.token).toBe('USDC');
    expect(tx.amountUsd).toBe(1000);
    expect(tx.status).toBe('pending');
    expect(tx.feeUsd).toBeGreaterThan(0);
    expect(tx.estimatedDurationMs).toBeGreaterThan(0);
    expect(tx.completedAt).toBeNull();
    expect(tx.agentId).toBe('agent-1');
  });

  it('retrieves a tracked transaction by ID', () => {
    const tx = service.trackTransaction({
      provider: 'debridge',
      sourceTxHash: '0xdef456',
      sourceChain: 'ethereum',
      destChain: 'arbitrum',
      token: 'ETH',
      amountUsd: 5000,
    });

    const retrieved = service.getTransaction(tx.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(tx.id);
    expect(retrieved!.provider).toBe('debridge');
    expect(retrieved!.agentId).toBeNull();
  });

  it('returns null for unknown transaction ID', () => {
    expect(service.getTransaction('nonexistent-id')).toBeNull();
  });

  it('updates transaction status to completed', () => {
    const tx = service.trackTransaction({
      provider: 'allbridge',
      sourceTxHash: '0xghi789',
      sourceChain: 'bsc',
      destChain: 'polygon',
      token: 'USDC',
      amountUsd: 2000,
    });

    expect(tx.status).toBe('pending');

    const updated = service.updateTransactionStatus(tx.id, 'completed');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.actualDurationMs).not.toBeNull();
    expect(updated!.actualDurationMs!).toBeGreaterThanOrEqual(0);
  });

  it('marks stuck transactions and reflects in health', () => {
    // Track several transactions as stuck for wormhole
    for (let i = 0; i < 3; i++) {
      const tx = service.trackTransaction({
        provider: 'wormhole',
        sourceTxHash: `0xstuck${i}`,
        sourceChain: 'solana',
        destChain: 'ethereum',
        token: 'SOL',
        amountUsd: 100,
      });
      service.updateTransactionStatus(tx.id, 'stuck');
    }

    const health = service.getAllBridgeHealth();
    const wormholeHealth = health.find((h) => h.provider === 'wormhole')!;
    expect(wormholeHealth.stuckTransactions).toBe(3);
    expect(wormholeHealth.status).toBe('degraded');
  });

  it('lists transactions by agent and by provider', () => {
    service.trackTransaction({
      provider: 'wormhole',
      sourceTxHash: '0xa1',
      sourceChain: 'solana',
      destChain: 'ethereum',
      token: 'USDC',
      amountUsd: 500,
      agentId: 'agent-A',
    });
    service.trackTransaction({
      provider: 'debridge',
      sourceTxHash: '0xa2',
      sourceChain: 'ethereum',
      destChain: 'polygon',
      token: 'ETH',
      amountUsd: 1000,
      agentId: 'agent-B',
    });
    service.trackTransaction({
      provider: 'wormhole',
      sourceTxHash: '0xa3',
      sourceChain: 'solana',
      destChain: 'bsc',
      token: 'SOL',
      amountUsd: 750,
      agentId: 'agent-A',
    });

    const agentA = service.getTransactionsByAgent('agent-A');
    expect(agentA).toHaveLength(2);

    const wormholeTxs = service.getTransactionsByProvider('wormhole');
    expect(wormholeTxs).toHaveLength(2);

    const allTxs = service.getAllTransactions();
    expect(allTxs.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Cross-Chain Arbitrage Opportunities ──────────────────────────────

  it('returns seeded arbitrage opportunities', () => {
    const opps = service.getOpportunities();
    expect(opps.length).toBeGreaterThanOrEqual(3);

    for (const opp of opps) {
      expect(opp.id).toBeDefined();
      expect(opp.token).toBeDefined();
      expect(opp.sourceChain).toBeDefined();
      expect(opp.destChain).toBeDefined();
      expect(opp.spreadPct).toBeDefined();
      expect(opp.detectedAt).toBeDefined();
      expect(opp.expiresAt).toBeDefined();
      expect(typeof opp.viable).toBe('boolean');
    }
  });

  it('filters viable-only arbitrage opportunities', () => {
    const all = service.getOpportunities();
    const viableOnly = service.getOpportunities(true);
    expect(viableOnly.length).toBeLessThanOrEqual(all.length);
    for (const opp of viableOnly) {
      expect(opp.viable).toBe(true);
      expect(opp.netProfitUsd).toBeGreaterThan(0);
    }
  });

  it('adds a custom arbitrage opportunity', () => {
    const before = service.getOpportunities().length;
    const opp = service.addOpportunity({
      token: 'MATIC',
      sourceChain: 'polygon',
      destChain: 'ethereum',
      sourcePriceUsd: 0.85,
      destPriceUsd: 0.88,
      spreadPct: 3.53,
      estimatedBridgeFeeUsd: 0.90,
      estimatedBridgeTimeMs: 90_000,
      netProfitUsd: 2.10,
      netProfitPct: 2.47,
      recommendedProvider: 'wormhole',
    });

    expect(opp.id).toBeDefined();
    expect(opp.viable).toBe(true);
    expect(service.getOpportunities().length).toBe(before + 1);
  });

  // ─── Fee Comparison ───────────────────────────────────────────────────

  it('compares bridge fees across providers', () => {
    const comparison = service.compareFees('solana', 'ethereum', 'USDC', 1000);

    expect(comparison.sourceChain).toBe('solana');
    expect(comparison.destChain).toBe('ethereum');
    expect(comparison.token).toBe('USDC');
    expect(comparison.providers).toHaveLength(3);
    expect(comparison.cheapest).toBeDefined();
    expect(comparison.fastest).toBeDefined();
    expect(comparison.queriedAt).toBeDefined();

    // All providers should have positive fees
    for (const p of comparison.providers) {
      expect(p.feeUsd).toBeGreaterThan(0);
      expect(p.feePct).toBeGreaterThan(0);
      expect(p.estimatedTimeMs).toBeGreaterThan(0);
      expect(p.available).toBe(true);
    }

    // debridge should be fastest (60_000ms vs 90_000 and 120_000)
    expect(comparison.fastest).toBe('debridge');
  });

  it('uses defaults for fee comparison when token/amount omitted', () => {
    const comparison = service.compareFees('ethereum', 'polygon');
    expect(comparison.token).toBe('USDC');
    expect(comparison.providers).toHaveLength(3);
    expect(comparison.cheapest).toBeDefined();
  });

  // ─── Bridge Risk Scoring ──────────────────────────────────────────────

  it('returns risk scores for all bridge providers', () => {
    const scores = service.getRiskScores();
    expect(scores).toHaveLength(3);

    for (const score of scores) {
      expect(score.overallScore).toBeGreaterThanOrEqual(0);
      expect(score.overallScore).toBeLessThanOrEqual(100);
      expect(score.securityScore).toBeGreaterThanOrEqual(0);
      expect(score.reliabilityScore).toBeGreaterThanOrEqual(0);
      expect(score.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(score.decentralizationScore).toBeGreaterThanOrEqual(0);
      expect(score.auditStatus).toMatch(/^(audited|partial|unaudited)$/);
      expect(score.tvlUsd).toBeGreaterThan(0);
      expect(score.lastAssessedAt).toBeDefined();
    }

    // Wormhole should have highest overall score
    const wormhole = scores.find((s) => s.provider === 'wormhole')!;
    const allbridge = scores.find((s) => s.provider === 'allbridge')!;
    expect(wormhole.overallScore).toBeGreaterThan(allbridge.overallScore);
  });

  it('returns risk score for a single provider', () => {
    const score = service.getRiskScore('debridge');
    expect(score.provider).toBe('debridge');
    expect(score.auditStatus).toBe('audited');
    expect(score.historicalIncidents).toBe(0);
  });

  // ─── Cross-Chain Portfolio View ───────────────────────────────────────

  it('builds cross-chain portfolio from bridge transactions', () => {
    // Track and complete some transactions
    const tx1 = service.trackTransaction({
      provider: 'wormhole',
      sourceTxHash: '0xp1',
      sourceChain: 'solana',
      destChain: 'ethereum',
      token: 'USDC',
      amountUsd: 1000,
      agentId: 'agent-portfolio',
    });
    service.updateTransactionStatus(tx1.id, 'completed');

    const tx2 = service.trackTransaction({
      provider: 'debridge',
      sourceTxHash: '0xp2',
      sourceChain: 'solana',
      destChain: 'bsc',
      token: 'SOL',
      amountUsd: 500,
      agentId: 'agent-portfolio',
    });
    service.updateTransactionStatus(tx2.id, 'completed');

    // One still in flight
    service.trackTransaction({
      provider: 'allbridge',
      sourceTxHash: '0xp3',
      sourceChain: 'ethereum',
      destChain: 'polygon',
      token: 'ETH',
      amountUsd: 2000,
      agentId: 'agent-portfolio',
    });

    service.invalidatePortfolio('agent-portfolio');
    const portfolio = service.getCrossChainPortfolio('agent-portfolio');

    expect(portfolio.agentId).toBe('agent-portfolio');
    expect(portfolio.totalValueUsd).toBeGreaterThan(0);
    expect(portfolio.inFlightValueUsd).toBe(2000);
    expect(portfolio.pendingBridgeTxs).toBe(1);
    expect(portfolio.chains.ethereum.totalValueUsd).toBeGreaterThan(0);
    expect(portfolio.chains.bsc.totalValueUsd).toBeGreaterThan(0);
    expect(portfolio.generatedAt).toBeDefined();
  });

  it('returns empty portfolio for agent with no transactions', () => {
    const portfolio = service.getCrossChainPortfolio('agent-empty');
    expect(portfolio.agentId).toBe('agent-empty');
    expect(portfolio.totalValueUsd).toBe(0);
    expect(portfolio.inFlightValueUsd).toBe(0);
    expect(portfolio.pendingBridgeTxs).toBe(0);
  });

  it('caches portfolio and invalidates correctly', () => {
    const portfolio1 = service.getCrossChainPortfolio('agent-cache');
    const portfolio2 = service.getCrossChainPortfolio('agent-cache');
    // Should return same cached reference
    expect(portfolio1.generatedAt).toBe(portfolio2.generatedAt);

    service.invalidatePortfolio('agent-cache');
    // After invalidation, new one is generated
    const portfolio3 = service.getCrossChainPortfolio('agent-cache');
    expect(portfolio3.agentId).toBe('agent-cache');
  });

  // ─── Edge case: update status on nonexistent tx ───────────────────────

  it('returns null when updating status of nonexistent transaction', () => {
    const result = service.updateTransactionStatus('no-such-tx', 'completed');
    expect(result).toBeNull();
  });

  // ─── Fee calculation correctness ──────────────────────────────────────

  it('calculates correct fee based on provider rate', () => {
    const tx = service.trackTransaction({
      provider: 'wormhole',
      sourceTxHash: '0xfee-check',
      sourceChain: 'solana',
      destChain: 'ethereum',
      token: 'USDC',
      amountUsd: 10_000,
    });

    // wormhole: baseFee=0.50, feePct=0.04 → 0.50 + (10_000 * 0.04/100) = 0.50 + 4.00 = 4.50
    expect(tx.feeUsd).toBe(4.50);
  });
});
