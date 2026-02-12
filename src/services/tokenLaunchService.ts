/**
 * Token Launch & Bonding Curve Service.
 *
 * Manages token launches with configurable bonding curves (linear, exponential, sigmoid).
 * Provides:
 * - Token launch configuration (name, symbol, supply, initial price, curve parameters)
 * - Bonding curve math for buy/sell price calculation
 * - Market cap estimation at different supply levels
 * - Liquidity pool creation simulation
 * - Launch analytics (volume, unique buyers, price trajectory)
 */

import { v4 as uuid } from 'uuid';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type CurveType = 'linear' | 'exponential' | 'sigmoid';

export interface CurveParameters {
  /** Curve type: linear, exponential, or sigmoid */
  type: CurveType;
  /** Linear: slope (price increase per unit sold). Exponential: growth rate. Sigmoid: steepness. */
  slope: number;
  /** Sigmoid midpoint (fraction of maxSupply at which inflection occurs). Ignored for linear/exponential. */
  midpoint?: number;
}

export interface TokenLaunchConfig {
  name: string;
  symbol: string;
  maxSupply: number;
  initialPrice: number;
  curveParams: CurveParameters;
  creatorId?: string;
}

export interface TokenLaunch {
  id: string;
  name: string;
  symbol: string;
  maxSupply: number;
  initialPrice: number;
  curveParams: CurveParameters;
  creatorId: string | null;
  currentSupplySold: number;
  totalVolumeSold: number;
  totalVolumeBought: number;
  transactions: LaunchTransaction[];
  liquidityPool: LiquidityPool | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchTransaction {
  id: string;
  launchId: string;
  buyerId: string;
  side: 'buy' | 'sell';
  quantity: number;
  avgPrice: number;
  totalCost: number;
  timestamp: string;
}

export interface LiquidityPool {
  id: string;
  launchId: string;
  baseToken: string;
  quoteToken: string;
  baseReserve: number;
  quoteReserve: number;
  lpTokenSupply: number;
  createdAt: string;
}

export interface BuyResult {
  transaction: LaunchTransaction;
  avgPrice: number;
  totalCost: number;
  newSupplySold: number;
  newSpotPrice: number;
}

export interface SellResult {
  transaction: LaunchTransaction;
  avgPrice: number;
  totalProceeds: number;
  newSupplySold: number;
  newSpotPrice: number;
}

export interface MarketCapEstimate {
  supplyLevel: number;
  spotPrice: number;
  marketCap: number;
}

export interface LaunchAnalytics {
  launchId: string;
  symbol: string;
  totalVolumeSold: number;
  totalVolumeBought: number;
  netVolume: number;
  transactionCount: number;
  uniqueBuyers: number;
  currentSupplySold: number;
  currentSpotPrice: number;
  currentMarketCap: number;
  priceTrajectory: { supply: number; price: number }[];
  createdAt: string;
}

// ─── Bonding Curve Math ─────────────────────────────────────────────────

/**
 * Compute the spot price at a given supply level on the bonding curve.
 */
export function spotPrice(
  supply: number,
  initialPrice: number,
  curveParams: CurveParameters,
  maxSupply: number,
): number {
  if (supply < 0) return initialPrice;

  switch (curveParams.type) {
    case 'linear':
      // P(s) = initialPrice + slope * s
      return initialPrice + curveParams.slope * supply;

    case 'exponential':
      // P(s) = initialPrice * e^(slope * s)
      return initialPrice * Math.exp(curveParams.slope * supply);

    case 'sigmoid': {
      // P(s) = initialPrice + (maxPrice - initialPrice) / (1 + e^(-slope * (s - midpoint * maxSupply)))
      // maxPrice is derived so that at maxSupply the curve is near 2 * initialPrice * maxSupply * slope
      const midpoint = (curveParams.midpoint ?? 0.5) * maxSupply;
      const maxPrice = initialPrice * (1 + curveParams.slope * maxSupply);
      const sigmoid = 1 / (1 + Math.exp(-curveParams.slope * (supply - midpoint)));
      return initialPrice + (maxPrice - initialPrice) * sigmoid;
    }

    default:
      return initialPrice;
  }
}

/**
 * Compute the cost to buy `quantity` tokens starting from `currentSupply`.
 * Uses numerical integration (trapezoidal) for accuracy.
 */
export function computeBuyCost(
  currentSupply: number,
  quantity: number,
  initialPrice: number,
  curveParams: CurveParameters,
  maxSupply: number,
): { totalCost: number; avgPrice: number } {
  if (quantity <= 0) return { totalCost: 0, avgPrice: 0 };

  const steps = Math.max(100, Math.ceil(quantity));
  const stepSize = quantity / steps;
  let totalCost = 0;

  for (let i = 0; i < steps; i++) {
    const s0 = currentSupply + i * stepSize;
    const s1 = currentSupply + (i + 1) * stepSize;
    const p0 = spotPrice(s0, initialPrice, curveParams, maxSupply);
    const p1 = spotPrice(s1, initialPrice, curveParams, maxSupply);
    totalCost += (p0 + p1) / 2 * stepSize;
  }

  const avgPrice = totalCost / quantity;
  return { totalCost: Number(totalCost.toFixed(8)), avgPrice: Number(avgPrice.toFixed(8)) };
}

/**
 * Compute the proceeds from selling `quantity` tokens starting from `currentSupply`.
 */
export function computeSellProceeds(
  currentSupply: number,
  quantity: number,
  initialPrice: number,
  curveParams: CurveParameters,
  maxSupply: number,
): { totalProceeds: number; avgPrice: number } {
  if (quantity <= 0) return { totalProceeds: 0, avgPrice: 0 };

  const newSupply = currentSupply - quantity;
  const steps = Math.max(100, Math.ceil(quantity));
  const stepSize = quantity / steps;
  let totalProceeds = 0;

  for (let i = 0; i < steps; i++) {
    const s0 = newSupply + i * stepSize;
    const s1 = newSupply + (i + 1) * stepSize;
    const p0 = spotPrice(s0, initialPrice, curveParams, maxSupply);
    const p1 = spotPrice(s1, initialPrice, curveParams, maxSupply);
    totalProceeds += (p0 + p1) / 2 * stepSize;
  }

  const avgPrice = totalProceeds / quantity;
  return { totalProceeds: Number(totalProceeds.toFixed(8)), avgPrice: Number(avgPrice.toFixed(8)) };
}

// ─── Service ────────────────────────────────────────────────────────────

export class TokenLaunchService {
  private launches: Map<string, TokenLaunch> = new Map();

  /**
   * Create a new token launch with bonding curve configuration.
   */
  createLaunch(config: TokenLaunchConfig): TokenLaunch {
    const id = uuid();
    const now = isoNow();

    const launch: TokenLaunch = {
      id,
      name: config.name,
      symbol: config.symbol.toUpperCase(),
      maxSupply: config.maxSupply,
      initialPrice: config.initialPrice,
      curveParams: config.curveParams,
      creatorId: config.creatorId ?? null,
      currentSupplySold: 0,
      totalVolumeSold: 0,
      totalVolumeBought: 0,
      transactions: [],
      liquidityPool: null,
      createdAt: now,
      updatedAt: now,
    };

    this.launches.set(id, launch);
    return structuredClone(launch);
  }

  /**
   * Get launch by ID.
   */
  getLaunch(id: string): TokenLaunch | null {
    const launch = this.launches.get(id);
    return launch ? structuredClone(launch) : null;
  }

  /**
   * List all launches.
   */
  listLaunches(): TokenLaunch[] {
    return Array.from(this.launches.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((l) => structuredClone(l));
  }

  /**
   * Buy tokens on the bonding curve.
   */
  buy(launchId: string, buyerId: string, quantity: number): BuyResult {
    const launch = this.launches.get(launchId);
    if (!launch) throw new Error(`Launch not found: ${launchId}`);
    if (quantity <= 0) throw new Error('Quantity must be positive.');
    if (launch.currentSupplySold + quantity > launch.maxSupply) {
      throw new Error(`Cannot buy ${quantity} tokens. Only ${launch.maxSupply - launch.currentSupplySold} remaining.`);
    }

    const { totalCost, avgPrice } = computeBuyCost(
      launch.currentSupplySold,
      quantity,
      launch.initialPrice,
      launch.curveParams,
      launch.maxSupply,
    );

    const tx: LaunchTransaction = {
      id: uuid(),
      launchId,
      buyerId,
      side: 'buy',
      quantity,
      avgPrice,
      totalCost,
      timestamp: isoNow(),
    };

    launch.currentSupplySold += quantity;
    launch.totalVolumeBought += quantity;
    launch.transactions.push(tx);
    launch.updatedAt = isoNow();

    const newSpotPrice = spotPrice(
      launch.currentSupplySold,
      launch.initialPrice,
      launch.curveParams,
      launch.maxSupply,
    );

    return {
      transaction: structuredClone(tx),
      avgPrice,
      totalCost,
      newSupplySold: launch.currentSupplySold,
      newSpotPrice: Number(newSpotPrice.toFixed(8)),
    };
  }

  /**
   * Sell tokens back on the bonding curve.
   */
  sell(launchId: string, sellerId: string, quantity: number): SellResult {
    const launch = this.launches.get(launchId);
    if (!launch) throw new Error(`Launch not found: ${launchId}`);
    if (quantity <= 0) throw new Error('Quantity must be positive.');
    if (quantity > launch.currentSupplySold) {
      throw new Error(`Cannot sell ${quantity} tokens. Only ${launch.currentSupplySold} in circulation.`);
    }

    const { totalProceeds, avgPrice } = computeSellProceeds(
      launch.currentSupplySold,
      quantity,
      launch.initialPrice,
      launch.curveParams,
      launch.maxSupply,
    );

    const tx: LaunchTransaction = {
      id: uuid(),
      launchId,
      buyerId: sellerId,
      side: 'sell',
      quantity,
      avgPrice,
      totalCost: totalProceeds,
      timestamp: isoNow(),
    };

    launch.currentSupplySold -= quantity;
    launch.totalVolumeSold += quantity;
    launch.transactions.push(tx);
    launch.updatedAt = isoNow();

    const newSpotPrice = spotPrice(
      launch.currentSupplySold,
      launch.initialPrice,
      launch.curveParams,
      launch.maxSupply,
    );

    return {
      transaction: structuredClone(tx),
      avgPrice,
      totalProceeds,
      newSupplySold: launch.currentSupplySold,
      newSpotPrice: Number(newSpotPrice.toFixed(8)),
    };
  }

  /**
   * Estimate market cap at various supply levels.
   */
  estimateMarketCap(launchId: string, supplyLevels?: number[]): MarketCapEstimate[] {
    const launch = this.launches.get(launchId);
    if (!launch) throw new Error(`Launch not found: ${launchId}`);

    const levels = supplyLevels ?? [
      0,
      launch.maxSupply * 0.1,
      launch.maxSupply * 0.25,
      launch.maxSupply * 0.5,
      launch.maxSupply * 0.75,
      launch.maxSupply,
    ];

    return levels.map((s) => {
      const price = spotPrice(s, launch.initialPrice, launch.curveParams, launch.maxSupply);
      return {
        supplyLevel: s,
        spotPrice: Number(price.toFixed(8)),
        marketCap: Number((price * s).toFixed(8)),
      };
    });
  }

  /**
   * Simulate creating a liquidity pool for a launched token.
   */
  createLiquidityPool(
    launchId: string,
    quoteToken: string,
    baseReserve: number,
    quoteReserve: number,
  ): LiquidityPool {
    const launch = this.launches.get(launchId);
    if (!launch) throw new Error(`Launch not found: ${launchId}`);
    if (launch.liquidityPool) throw new Error('Liquidity pool already exists for this launch.');
    if (baseReserve <= 0 || quoteReserve <= 0) throw new Error('Reserves must be positive.');

    const pool: LiquidityPool = {
      id: uuid(),
      launchId,
      baseToken: launch.symbol,
      quoteToken: quoteToken.toUpperCase(),
      baseReserve,
      quoteReserve,
      lpTokenSupply: Math.sqrt(baseReserve * quoteReserve),
      createdAt: isoNow(),
    };

    launch.liquidityPool = pool;
    launch.updatedAt = isoNow();

    return structuredClone(pool);
  }

  /**
   * Compute launch analytics.
   */
  getAnalytics(launchId: string): LaunchAnalytics {
    const launch = this.launches.get(launchId);
    if (!launch) throw new Error(`Launch not found: ${launchId}`);

    const uniqueBuyers = new Set(
      launch.transactions.filter((tx) => tx.side === 'buy').map((tx) => tx.buyerId),
    ).size;

    const currentPrice = spotPrice(
      launch.currentSupplySold,
      launch.initialPrice,
      launch.curveParams,
      launch.maxSupply,
    );

    // Generate price trajectory at 10 supply checkpoints
    const trajectoryPoints = 10;
    const step = launch.maxSupply / trajectoryPoints;
    const priceTrajectory: { supply: number; price: number }[] = [];
    for (let i = 0; i <= trajectoryPoints; i++) {
      const s = i * step;
      priceTrajectory.push({
        supply: Number(s.toFixed(2)),
        price: Number(spotPrice(s, launch.initialPrice, launch.curveParams, launch.maxSupply).toFixed(8)),
      });
    }

    return {
      launchId,
      symbol: launch.symbol,
      totalVolumeSold: launch.totalVolumeSold,
      totalVolumeBought: launch.totalVolumeBought,
      netVolume: launch.totalVolumeBought - launch.totalVolumeSold,
      transactionCount: launch.transactions.length,
      uniqueBuyers,
      currentSupplySold: launch.currentSupplySold,
      currentSpotPrice: Number(currentPrice.toFixed(8)),
      currentMarketCap: Number((currentPrice * launch.currentSupplySold).toFixed(8)),
      priceTrajectory,
      createdAt: launch.createdAt,
    };
  }
}
