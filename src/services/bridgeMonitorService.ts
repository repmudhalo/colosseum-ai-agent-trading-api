import { v4 as uuid } from 'uuid';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type BridgeProvider = 'wormhole' | 'debridge' | 'allbridge';
export type BridgeTxStatus = 'pending' | 'in-flight' | 'completed' | 'failed' | 'stuck';
export type ChainId = 'solana' | 'ethereum' | 'bsc' | 'polygon' | 'avalanche' | 'arbitrum' | 'optimism';

export interface BridgeTransaction {
  id: string;
  provider: BridgeProvider;
  sourceTxHash: string;
  sourceChain: ChainId;
  destChain: ChainId;
  token: string;
  amountUsd: number;
  feeUsd: number;
  status: BridgeTxStatus;
  initiatedAt: string;
  completedAt: string | null;
  estimatedDurationMs: number;
  actualDurationMs: number | null;
  agentId: string | null;
}

export interface BridgeHealth {
  provider: BridgeProvider;
  status: 'healthy' | 'degraded' | 'down';
  uptimePct: number;
  avgTransferTimeMs: number;
  pendingTransactions: number;
  stuckTransactions: number;
  lastIncidentAt: string | null;
  checkedAt: string;
}

export interface CrossChainArbitrageOpportunity {
  id: string;
  token: string;
  sourceChain: ChainId;
  destChain: ChainId;
  sourcePriceUsd: number;
  destPriceUsd: number;
  spreadPct: number;
  estimatedBridgeFeeUsd: number;
  estimatedBridgeTimeMs: number;
  netProfitUsd: number;
  netProfitPct: number;
  recommendedProvider: BridgeProvider;
  detectedAt: string;
  expiresAt: string;
  viable: boolean;
}

export interface BridgeFeeComparison {
  sourceChain: ChainId;
  destChain: ChainId;
  token: string;
  providers: Array<{
    provider: BridgeProvider;
    feeUsd: number;
    feePct: number;
    estimatedTimeMs: number;
    available: boolean;
  }>;
  cheapest: BridgeProvider;
  fastest: BridgeProvider;
  queriedAt: string;
}

export interface BridgeRiskScore {
  provider: BridgeProvider;
  overallScore: number; // 0-100
  securityScore: number;
  reliabilityScore: number;
  liquidityScore: number;
  decentralizationScore: number;
  auditStatus: 'audited' | 'partial' | 'unaudited';
  tvlUsd: number;
  historicalIncidents: number;
  lastAssessedAt: string;
}

export interface CrossChainPortfolioView {
  agentId: string;
  chains: Record<ChainId, {
    totalValueUsd: number;
    tokens: Array<{ token: string; amountUsd: number }>;
  }>;
  totalValueUsd: number;
  inFlightValueUsd: number;
  pendingBridgeTxs: number;
  generatedAt: string;
}

export interface TrackBridgeTxInput {
  provider: BridgeProvider;
  sourceTxHash: string;
  sourceChain: ChainId;
  destChain: ChainId;
  token: string;
  amountUsd: number;
  agentId?: string;
}

// ─── Static bridge data ─────────────────────────────────────────────────

const BRIDGE_BASE_FEES: Record<BridgeProvider, { baseFeeUsd: number; feePct: number; avgTimeMs: number }> = {
  wormhole: { baseFeeUsd: 0.50, feePct: 0.04, avgTimeMs: 90_000 },
  debridge: { baseFeeUsd: 0.80, feePct: 0.06, avgTimeMs: 60_000 },
  allbridge: { baseFeeUsd: 1.20, feePct: 0.08, avgTimeMs: 120_000 },
};

const BRIDGE_RISK_PROFILES: Record<BridgeProvider, Omit<BridgeRiskScore, 'lastAssessedAt'>> = {
  wormhole: {
    provider: 'wormhole',
    overallScore: 82,
    securityScore: 78,
    reliabilityScore: 85,
    liquidityScore: 90,
    decentralizationScore: 75,
    auditStatus: 'audited',
    tvlUsd: 2_800_000_000,
    historicalIncidents: 2,
  },
  debridge: {
    provider: 'debridge',
    overallScore: 79,
    securityScore: 80,
    reliabilityScore: 82,
    liquidityScore: 72,
    decentralizationScore: 82,
    auditStatus: 'audited',
    tvlUsd: 450_000_000,
    historicalIncidents: 0,
  },
  allbridge: {
    provider: 'allbridge',
    overallScore: 68,
    securityScore: 65,
    reliabilityScore: 70,
    liquidityScore: 60,
    decentralizationScore: 55,
    auditStatus: 'partial',
    tvlUsd: 120_000_000,
    historicalIncidents: 1,
  },
};

const ALL_PROVIDERS: BridgeProvider[] = ['wormhole', 'debridge', 'allbridge'];

// ─── Service ────────────────────────────────────────────────────────────

export class BridgeMonitorService {
  private transactions: Map<string, BridgeTransaction> = new Map();
  private opportunities: CrossChainArbitrageOpportunity[] = [];
  private healthCache: Map<BridgeProvider, BridgeHealth> = new Map();
  private portfolios: Map<string, CrossChainPortfolioView> = new Map();

  constructor() {
    this.initHealthCache();
    this.seedOpportunities();
  }

  // ─── Health monitoring ──────────────────────────────────────────────

  private initHealthCache(): void {
    const now = isoNow();
    for (const provider of ALL_PROVIDERS) {
      const base = BRIDGE_BASE_FEES[provider];
      this.healthCache.set(provider, {
        provider,
        status: 'healthy',
        uptimePct: 99.0 + Math.random() * 0.95,
        avgTransferTimeMs: base.avgTimeMs,
        pendingTransactions: Math.floor(Math.random() * 50),
        stuckTransactions: 0,
        lastIncidentAt: null,
        checkedAt: now,
      });
    }
  }

  getAllBridgeHealth(): BridgeHealth[] {
    const now = isoNow();

    // Recompute stuck counts from tracked transactions
    for (const provider of ALL_PROVIDERS) {
      const health = this.healthCache.get(provider)!;
      const txs = this.getTransactionsByProvider(provider);
      const stuckCount = txs.filter((tx) => tx.status === 'stuck').length;
      const pendingCount = txs.filter((tx) => tx.status === 'pending' || tx.status === 'in-flight').length;

      let status: BridgeHealth['status'] = 'healthy';
      if (stuckCount > 5 || health.uptimePct < 95) status = 'down';
      else if (stuckCount > 0 || pendingCount > 20) status = 'degraded';

      health.stuckTransactions = stuckCount;
      health.pendingTransactions = pendingCount;
      health.status = status;
      health.checkedAt = now;
    }

    return ALL_PROVIDERS.map((p) => this.healthCache.get(p)!);
  }

  getBridgeHealth(provider: BridgeProvider): BridgeHealth | null {
    return this.healthCache.get(provider) ?? null;
  }

  // ─── Transaction tracking ──────────────────────────────────────────

  trackTransaction(input: TrackBridgeTxInput): BridgeTransaction {
    const now = isoNow();
    const base = BRIDGE_BASE_FEES[input.provider];
    const feeUsd = base.baseFeeUsd + (input.amountUsd * base.feePct / 100);

    const tx: BridgeTransaction = {
      id: uuid(),
      provider: input.provider,
      sourceTxHash: input.sourceTxHash,
      sourceChain: input.sourceChain,
      destChain: input.destChain,
      token: input.token,
      amountUsd: input.amountUsd,
      feeUsd: Number(feeUsd.toFixed(4)),
      status: 'pending',
      initiatedAt: now,
      completedAt: null,
      estimatedDurationMs: base.avgTimeMs,
      actualDurationMs: null,
      agentId: input.agentId ?? null,
    };

    this.transactions.set(tx.id, tx);
    return tx;
  }

  getTransaction(txId: string): BridgeTransaction | null {
    return this.transactions.get(txId) ?? null;
  }

  getTransactionsByProvider(provider: BridgeProvider): BridgeTransaction[] {
    return [...this.transactions.values()].filter((tx) => tx.provider === provider);
  }

  getTransactionsByAgent(agentId: string): BridgeTransaction[] {
    return [...this.transactions.values()].filter((tx) => tx.agentId === agentId);
  }

  updateTransactionStatus(txId: string, status: BridgeTxStatus): BridgeTransaction | null {
    const tx = this.transactions.get(txId);
    if (!tx) return null;

    tx.status = status;
    if (status === 'completed' || status === 'failed') {
      tx.completedAt = isoNow();
      tx.actualDurationMs = new Date(tx.completedAt).getTime() - new Date(tx.initiatedAt).getTime();
    }

    return tx;
  }

  getAllTransactions(limit = 50): BridgeTransaction[] {
    return [...this.transactions.values()]
      .sort((a, b) => b.initiatedAt.localeCompare(a.initiatedAt))
      .slice(0, limit);
  }

  // ─── Cross-chain arbitrage opportunities ───────────────────────────

  private seedOpportunities(): void {
    const now = Date.now();
    const pairs: Array<{ token: string; src: ChainId; dest: ChainId; srcPrice: number; destPrice: number }> = [
      { token: 'USDC', src: 'solana', dest: 'ethereum', srcPrice: 0.9998, destPrice: 1.0003 },
      { token: 'ETH', src: 'ethereum', dest: 'arbitrum', srcPrice: 3200, destPrice: 3208 },
      { token: 'SOL', src: 'solana', dest: 'bsc', srcPrice: 185.50, destPrice: 186.20 },
    ];

    for (const p of pairs) {
      const spreadPct = ((p.destPrice - p.srcPrice) / p.srcPrice) * 100;
      const bestFee = Math.min(...ALL_PROVIDERS.map((prov) => {
        const base = BRIDGE_BASE_FEES[prov];
        return base.baseFeeUsd + (p.srcPrice * 100 * base.feePct / 100);
      }));
      const netProfitUsd = (p.destPrice - p.srcPrice) * 100 - bestFee;
      const netProfitPct = (netProfitUsd / (p.srcPrice * 100)) * 100;

      this.opportunities.push({
        id: uuid(),
        token: p.token,
        sourceChain: p.src,
        destChain: p.dest,
        sourcePriceUsd: p.srcPrice,
        destPriceUsd: p.destPrice,
        spreadPct: Number(spreadPct.toFixed(4)),
        estimatedBridgeFeeUsd: Number(bestFee.toFixed(4)),
        estimatedBridgeTimeMs: 60_000,
        netProfitUsd: Number(netProfitUsd.toFixed(4)),
        netProfitPct: Number(netProfitPct.toFixed(4)),
        recommendedProvider: 'debridge',
        detectedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
        viable: netProfitUsd > 0,
      });
    }
  }

  getOpportunities(viableOnly = false): CrossChainArbitrageOpportunity[] {
    if (viableOnly) return this.opportunities.filter((o) => o.viable);
    return [...this.opportunities];
  }

  addOpportunity(opp: Omit<CrossChainArbitrageOpportunity, 'id' | 'detectedAt' | 'expiresAt' | 'viable'>): CrossChainArbitrageOpportunity {
    const now = Date.now();
    const full: CrossChainArbitrageOpportunity = {
      ...opp,
      id: uuid(),
      detectedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      viable: opp.netProfitUsd > 0,
    };
    this.opportunities.push(full);
    return full;
  }

  // ─── Fee comparison ───────────────────────────────────────────────

  compareFees(sourceChain: ChainId, destChain: ChainId, token = 'USDC', amountUsd = 1000): BridgeFeeComparison {
    const providers = ALL_PROVIDERS.map((provider) => {
      const base = BRIDGE_BASE_FEES[provider];
      const feeUsd = base.baseFeeUsd + (amountUsd * base.feePct / 100);
      return {
        provider,
        feeUsd: Number(feeUsd.toFixed(4)),
        feePct: Number(((feeUsd / amountUsd) * 100).toFixed(4)),
        estimatedTimeMs: base.avgTimeMs,
        available: true,
      };
    });

    const cheapest = providers.reduce((a, b) => (a.feeUsd <= b.feeUsd ? a : b)).provider;
    const fastest = providers.reduce((a, b) => (a.estimatedTimeMs <= b.estimatedTimeMs ? a : b)).provider;

    return {
      sourceChain,
      destChain,
      token,
      providers,
      cheapest,
      fastest,
      queriedAt: isoNow(),
    };
  }

  // ─── Bridge risk scoring ──────────────────────────────────────────

  getRiskScores(): BridgeRiskScore[] {
    const now = isoNow();
    return ALL_PROVIDERS.map((provider) => ({
      ...BRIDGE_RISK_PROFILES[provider],
      lastAssessedAt: now,
    }));
  }

  getRiskScore(provider: BridgeProvider): BridgeRiskScore {
    return {
      ...BRIDGE_RISK_PROFILES[provider],
      lastAssessedAt: isoNow(),
    };
  }

  // ─── Cross-chain portfolio view ────────────────────────────────────

  getCrossChainPortfolio(agentId: string): CrossChainPortfolioView {
    const cached = this.portfolios.get(agentId);
    if (cached) return cached;

    // Build a default view from tracked bridge transactions
    const agentTxs = this.getTransactionsByAgent(agentId);
    const chains: CrossChainPortfolioView['chains'] = {} as any;

    const allChains: ChainId[] = ['solana', 'ethereum', 'bsc', 'polygon', 'avalanche', 'arbitrum', 'optimism'];
    for (const chain of allChains) {
      chains[chain] = { totalValueUsd: 0, tokens: [] };
    }

    // Accumulate from completed bridge txs
    let inFlightValueUsd = 0;
    let pendingBridgeTxs = 0;

    for (const tx of agentTxs) {
      if (tx.status === 'completed') {
        const destEntry = chains[tx.destChain];
        if (destEntry) {
          destEntry.totalValueUsd += tx.amountUsd - tx.feeUsd;
          const existing = destEntry.tokens.find((t) => t.token === tx.token);
          if (existing) {
            existing.amountUsd += tx.amountUsd - tx.feeUsd;
          } else {
            destEntry.tokens.push({ token: tx.token, amountUsd: tx.amountUsd - tx.feeUsd });
          }
        }
      } else if (tx.status === 'pending' || tx.status === 'in-flight') {
        inFlightValueUsd += tx.amountUsd;
        pendingBridgeTxs += 1;
      }
    }

    const totalValueUsd = Object.values(chains).reduce((sum, c) => sum + c.totalValueUsd, 0);

    const view: CrossChainPortfolioView = {
      agentId,
      chains,
      totalValueUsd: Number(totalValueUsd.toFixed(4)),
      inFlightValueUsd: Number(inFlightValueUsd.toFixed(4)),
      pendingBridgeTxs,
      generatedAt: isoNow(),
    };

    this.portfolios.set(agentId, view);
    return view;
  }

  // Clear the cached portfolio so next call rebuilds it
  invalidatePortfolio(agentId: string): void {
    this.portfolios.delete(agentId);
  }
}
