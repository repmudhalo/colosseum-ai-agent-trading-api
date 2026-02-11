/**
 * MEV Protection & Sandwich Attack Detection.
 *
 * Analyzes trade intents for sandwich attack risk and suggests protective measures.
 * Factors: order size vs pool liquidity, slippage tolerance, recent pool activity.
 */

export interface MevTradeIntent {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  slippageTolerance?: number;
  poolLiquidityUsd?: number;
  recentPoolTxCount?: number;
}

export interface MevFactor {
  name: string;
  score: number;
  description: string;
}

export type MevMitigation =
  | 'split_orders'
  | 'use_private_rpc'
  | 'reduce_slippage'
  | 'use_twap'
  | 'use_limit_order'
  | 'increase_min_output';

export interface MevMitigationDetail {
  strategy: MevMitigation;
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface MevReport {
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  factors: MevFactor[];
  mitigations: MevMitigationDetail[];
  estimatedCostUsd: number;
  analyzedAt: string;
}

/** Default pool liquidity assumption when not provided. */
const DEFAULT_POOL_LIQUIDITY_USD = 500_000;

/** Default slippage tolerance. */
const DEFAULT_SLIPPAGE = 0.01; // 1%

/** Default recent tx count — moderate activity. */
const DEFAULT_RECENT_TX_COUNT = 50;

/**
 * Analyze sandwich attack risk for a given trade intent.
 * Returns a risk score from 0 to 100.
 */
export function analyzeSandwichRisk(intent: MevTradeIntent): MevReport {
  const poolLiquidity = intent.poolLiquidityUsd ?? DEFAULT_POOL_LIQUIDITY_USD;
  const slippage = intent.slippageTolerance ?? DEFAULT_SLIPPAGE;
  const recentTxCount = intent.recentPoolTxCount ?? DEFAULT_RECENT_TX_COUNT;

  const factors: MevFactor[] = [];

  // Factor 1: Order size relative to pool liquidity
  const sizeRatio = poolLiquidity > 0 ? intent.notionalUsd / poolLiquidity : 1;
  const sizeFactor = Math.min(sizeRatio * 100, 40);
  factors.push({
    name: 'order_size_ratio',
    score: Math.round(sizeFactor),
    description: `Order is ${(sizeRatio * 100).toFixed(2)}% of pool liquidity.`,
  });

  // Factor 2: Slippage tolerance (higher slippage = more profitable for attacker)
  const slippageFactor = Math.min(slippage * 1000, 30);
  factors.push({
    name: 'slippage_tolerance',
    score: Math.round(slippageFactor),
    description: `Slippage tolerance of ${(slippage * 100).toFixed(2)}% — ${slippage >= 0.02 ? 'high' : slippage >= 0.01 ? 'moderate' : 'low'} MEV opportunity.`,
  });

  // Factor 3: Recent pool activity (high activity = more frontrunning bots)
  const activityFactor = Math.min(recentTxCount / 5, 30);
  factors.push({
    name: 'pool_activity',
    score: Math.round(activityFactor),
    description: `${recentTxCount} recent transactions — ${recentTxCount >= 100 ? 'high' : recentTxCount >= 30 ? 'moderate' : 'low'} bot activity.`,
  });

  // Composite score: sum of factors, capped at 100
  const riskScore = Math.min(
    Math.round(factors.reduce((sum, f) => sum + f.score, 0)),
    100,
  );

  const riskLevel = riskScore >= 75 ? 'critical' : riskScore >= 50 ? 'high' : riskScore >= 25 ? 'medium' : 'low';

  // Estimated cost: proportional to risk and order size
  const estimatedCostUsd = Number(((riskScore / 100) * intent.notionalUsd * 0.005).toFixed(4));

  const mitigations = suggestProtection(riskScore, intent.notionalUsd);

  return {
    riskScore,
    riskLevel,
    factors,
    mitigations,
    estimatedCostUsd,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Suggest protection strategies based on risk score and order size.
 */
export function suggestProtection(riskScore: number, notionalUsd: number): MevMitigationDetail[] {
  const mitigations: MevMitigationDetail[] = [];

  if (riskScore >= 25) {
    mitigations.push({
      strategy: 'use_private_rpc',
      description: 'Route transactions through a private RPC (e.g., Jito) to avoid the public mempool.',
      priority: 'high',
    });
  }

  if (riskScore >= 40) {
    mitigations.push({
      strategy: 'reduce_slippage',
      description: 'Lower slippage tolerance to reduce the profitability window for sandwich attacks.',
      priority: 'high',
    });
  }

  if (notionalUsd >= 5_000 && riskScore >= 30) {
    mitigations.push({
      strategy: 'split_orders',
      description: 'Split large orders into smaller chunks to reduce individual trade impact.',
      priority: 'medium',
    });
  }

  if (notionalUsd >= 10_000 && riskScore >= 50) {
    mitigations.push({
      strategy: 'use_twap',
      description: 'Use a TWAP (Time-Weighted Average Price) strategy to execute over time.',
      priority: 'medium',
    });
  }

  if (riskScore >= 60) {
    mitigations.push({
      strategy: 'use_limit_order',
      description: 'Use limit orders instead of market orders to control execution price.',
      priority: 'medium',
    });
  }

  if (riskScore >= 50) {
    mitigations.push({
      strategy: 'increase_min_output',
      description: 'Set a minimum output amount to reject sandwiched transactions.',
      priority: 'low',
    });
  }

  return mitigations;
}
