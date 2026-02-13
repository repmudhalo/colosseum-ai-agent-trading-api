/**
 * Meteora DLMM Integration Service
 *
 * Comprehensive Meteora Dynamic Liquidity Market Maker integration:
 *
 *   - Pool Discovery — fetch DLMM pools from Meteora's public API
 *   - Position Management — paper/simulated LP positions per agent
 *   - Pool Analytics — APR/APY, volume tracking, bin distribution, IL estimation
 *   - Strategy Layer — auto-rebalance, concentrated liquidity, fee compounding
 */

import { isoNow } from '../utils/time.js';

// ─── Constants ──────────────────────────────────────────────────────────

const METEORA_API_BASE = 'https://dlmm-api.meteora.ag';
const FETCH_TIMEOUT_MS = 15_000;

// ─── Types ──────────────────────────────────────────────────────────────

export interface MeteoraPairRaw {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x: string;
  reserve_y: string;
  reserve_x_amount: number;
  reserve_y_amount: number;
  bin_step: number;
  base_fee_percentage: string;
  max_fee_percentage: string;
  protocol_fee_percentage: string;
  liquidity: string;
  reward_mint_x: string;
  reward_mint_y: string;
  fees_24h: number;
  today_fees: number;
  trade_volume_24h: number;
  cumulative_trade_volume: string;
  cumulative_fee_volume: string;
  current_price: number;
  apr: number;
  apy: number;
  hide: boolean;
}

export interface MeteoraPool {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  reserveX: number;
  reserveY: number;
  binStep: number;
  baseFeePct: number;
  maxFeePct: number;
  liquidity: number;
  fees24h: number;
  volume24h: number;
  cumulativeVolume: number;
  cumulativeFees: number;
  currentPrice: number;
  apr: number;
  apy: number;
  tvlUsd: number;
  lastUpdated: string;
}

export type LiquidityStrategy = 'spot' | 'curve' | 'bid-ask';

export interface MeteoraPosition {
  id: string;
  agentId: string;
  poolAddress: string;
  poolName: string;
  strategy: LiquidityStrategy;
  depositedAmountX: number;
  depositedAmountY: number;
  depositedValueUsd: number;
  currentValueUsd: number;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  feesEarnedUsd: number;
  feesClaimedUsd: number;
  unclaimedFeesUsd: number;
  impermanentLossUsd: number;
  entryPrice: number;
  currentPrice: number;
  isInRange: boolean;
  autoCompound: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'closed';
}

export interface BinData {
  binId: number;
  pricePerToken: number;
  liquidityX: number;
  liquidityY: number;
  totalLiquidity: number;
  supplyPct: number;
}

export interface PoolAnalytics {
  address: string;
  name: string;
  apr: number;
  apy: number;
  feeApr: number;
  volume24h: number;
  volume7d: number;
  fees24h: number;
  fees7d: number;
  tvlUsd: number;
  priceChange24hPct: number;
  binUtilization: number;
  activeBinId: number;
  binStep: number;
  concentrationScore: number;
}

export interface ILEstimate {
  poolAddress: string;
  entryPrice: number;
  currentPrice: number;
  priceChangeRatio: number;
  ilPct: number;
  ilUsd: number;
  holdValueUsd: number;
  lpValueUsd: number;
  feeCompensationNeeded: number;
  netReturn: number;
  breakEvenDays: number | null;
}

export interface TopPool {
  address: string;
  name: string;
  apr: number;
  apy: number;
  tvlUsd: number;
  volume24h: number;
  fees24h: number;
  riskScore: number;
}

export interface RebalanceResult {
  positionId: string;
  oldLowerBin: number;
  oldUpperBin: number;
  newLowerBin: number;
  newUpperBin: number;
  priceCurrent: number;
  rebalancedAt: string;
  estimatedGasCostUsd: number;
  message: string;
}

export interface AutoCompoundConfig {
  positionId: string;
  enabled: boolean;
  intervalHours: number;
  compoundsExecuted: number;
  totalCompoundedUsd: number;
  nextCompoundAt: string;
  estimatedApyBoost: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}

let positionCounter = 0;

function generatePositionId(): string {
  positionCounter += 1;
  return `met-pos-${Date.now()}-${positionCounter}`;
}

function mapRawPairToPool(raw: MeteoraPairRaw): MeteoraPool {
  const liquidity = Number(raw.liquidity) || 0;
  return {
    address: raw.address,
    name: raw.name,
    mintX: raw.mint_x,
    mintY: raw.mint_y,
    reserveX: raw.reserve_x_amount,
    reserveY: raw.reserve_y_amount,
    binStep: raw.bin_step,
    baseFeePct: Number(raw.base_fee_percentage) || 0,
    maxFeePct: Number(raw.max_fee_percentage) || 0,
    liquidity,
    fees24h: raw.fees_24h ?? raw.today_fees ?? 0,
    volume24h: raw.trade_volume_24h ?? 0,
    cumulativeVolume: Number(raw.cumulative_trade_volume) || 0,
    cumulativeFees: Number(raw.cumulative_fee_volume) || 0,
    currentPrice: raw.current_price ?? 0,
    apr: raw.apr ?? 0,
    apy: raw.apy ?? 0,
    tvlUsd: liquidity,
    lastUpdated: isoNow(),
  };
}

// ─── Seed Data (used when API is unreachable / paper mode) ──────────

const SEED_POOLS: MeteoraPool[] = [
  {
    address: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
    name: 'SOL-USDC',
    mintX: 'So11111111111111111111111111111111111111112',
    mintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    reserveX: 1_250_000,
    reserveY: 185_000_000,
    binStep: 10,
    baseFeePct: 0.04,
    maxFeePct: 2.0,
    liquidity: 95_000_000,
    fees24h: 42_350,
    volume24h: 28_500_000,
    cumulativeVolume: 5_200_000_000,
    cumulativeFees: 12_500_000,
    currentPrice: 148.0,
    apr: 162.6,
    apy: 410.2,
    tvlUsd: 95_000_000,
    lastUpdated: isoNow(),
  },
  {
    address: '7qbRF5N7gQDsEkPqW3KYiEk7VnBitq8F3Q7Z5LUz9WY',
    name: 'SOL-USDT',
    mintX: 'So11111111111111111111111111111111111111112',
    mintY: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    reserveX: 950_000,
    reserveY: 140_500_000,
    binStep: 15,
    baseFeePct: 0.06,
    maxFeePct: 3.0,
    liquidity: 72_000_000,
    fees24h: 35_200,
    volume24h: 22_100_000,
    cumulativeVolume: 3_800_000_000,
    cumulativeFees: 9_200_000,
    currentPrice: 147.9,
    apr: 178.4,
    apy: 480.0,
    tvlUsd: 72_000_000,
    lastUpdated: isoNow(),
  },
  {
    address: '2sf7pWqWry1GBBqiSWZYqR5hTuG56jHNZ7LdqFCsBqe8',
    name: 'JUP-USDC',
    mintX: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    mintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    reserveX: 12_000_000,
    reserveY: 9_600_000,
    binStep: 20,
    baseFeePct: 0.08,
    maxFeePct: 5.0,
    liquidity: 18_500_000,
    fees24h: 15_800,
    volume24h: 8_200_000,
    cumulativeVolume: 1_200_000_000,
    cumulativeFees: 3_400_000,
    currentPrice: 0.82,
    apr: 311.5,
    apy: 2045.0,
    tvlUsd: 18_500_000,
    lastUpdated: isoNow(),
  },
  {
    address: '3NdXyE5bJxNj7TBkNgEfzgyrZh9AYbTMcGmAqAp3R7nv',
    name: 'BONK-SOL',
    mintX: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    mintY: 'So11111111111111111111111111111111111111112',
    reserveX: 850_000_000_000,
    reserveY: 320_000,
    binStep: 80,
    baseFeePct: 0.25,
    maxFeePct: 10.0,
    liquidity: 8_500_000,
    fees24h: 12_400,
    volume24h: 5_100_000,
    cumulativeVolume: 680_000_000,
    cumulativeFees: 1_800_000,
    currentPrice: 0.0000000004,
    apr: 532.5,
    apy: 15200.0,
    tvlUsd: 8_500_000,
    lastUpdated: isoNow(),
  },
  {
    address: '9HgnkDJrW2R8KrGEwp4x6y6mz7MqKqNRvErTJ6gZFU4',
    name: 'WIF-USDC',
    mintX: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    mintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    reserveX: 4_200_000,
    reserveY: 6_300_000,
    binStep: 25,
    baseFeePct: 0.10,
    maxFeePct: 5.0,
    liquidity: 11_200_000,
    fees24h: 18_900,
    volume24h: 9_800_000,
    cumulativeVolume: 920_000_000,
    cumulativeFees: 2_600_000,
    currentPrice: 1.52,
    apr: 615.8,
    apy: 42000.0,
    tvlUsd: 11_200_000,
    lastUpdated: isoNow(),
  },
  {
    address: '4X1oYoFWYtLebk51zDUB1f2V44gXMbalMvTiPT6j2kmF',
    name: 'JTO-USDC',
    mintX: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    mintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    reserveX: 2_800_000,
    reserveY: 7_800_000,
    binStep: 15,
    baseFeePct: 0.06,
    maxFeePct: 3.0,
    liquidity: 14_200_000,
    fees24h: 9_200,
    volume24h: 6_100_000,
    cumulativeVolume: 780_000_000,
    cumulativeFees: 2_100_000,
    currentPrice: 2.82,
    apr: 236.4,
    apy: 960.0,
    tvlUsd: 14_200_000,
    lastUpdated: isoNow(),
  },
];

// ─── Service ────────────────────────────────────────────────────────────

export class MeteoraService {
  private poolCache: Map<string, MeteoraPool> = new Map();
  private positions: Map<string, MeteoraPosition> = new Map();
  private autoCompoundConfigs: Map<string, AutoCompoundConfig> = new Map();
  private poolCacheTimestamp = 0;
  private readonly cacheTtlMs: number;
  private readonly skipApi: boolean;

  constructor(opts?: { cacheTtlMs?: number; skipApi?: boolean }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
    this.skipApi = opts?.skipApi ?? false;
    // Seed initial pool data
    for (const pool of SEED_POOLS) {
      this.poolCache.set(pool.address, pool);
    }
    this.poolCacheTimestamp = Date.now();
  }

  // ─── Pool Discovery ─────────────────────────────────────────────────

  /**
   * Fetch all DLMM pairs from Meteora's public API.
   * Falls back to seed/cached data on failure.
   */
  async fetchAllPools(): Promise<MeteoraPool[]> {
    const now = Date.now();
    if (this.skipApi || (now - this.poolCacheTimestamp < this.cacheTtlMs && this.poolCache.size > 0)) {
      return Array.from(this.poolCache.values());
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${METEORA_API_BASE}/pair/all`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Meteora API returned ${response.status}`);
      }

      const raw: MeteoraPairRaw[] = await response.json() as MeteoraPairRaw[];
      const pools = raw
        .filter((p) => !p.hide)
        .map(mapRawPairToPool);

      // Refresh cache
      this.poolCache.clear();
      for (const pool of pools) {
        this.poolCache.set(pool.address, pool);
      }
      this.poolCacheTimestamp = now;

      return pools;
    } catch {
      // Return cached/seed data on failure
      return Array.from(this.poolCache.values());
    }
  }

  /**
   * Fetch a specific pool by address from the Meteora API.
   */
  async fetchPool(pairAddress: string): Promise<MeteoraPool | null> {
    // Check cache first
    const cached = this.poolCache.get(pairAddress);

    if (this.skipApi) {
      return cached ?? null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${METEORA_API_BASE}/pair/${pairAddress}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return cached ?? null;
      }

      const raw: MeteoraPairRaw = await response.json() as MeteoraPairRaw;
      const pool = mapRawPairToPool(raw);
      this.poolCache.set(pool.address, pool);
      return pool;
    } catch {
      return cached ?? null;
    }
  }

  /**
   * List pools with filters (works on cached data for speed).
   */
  async listPools(filters?: {
    token?: string;
    minTvl?: number;
    minApr?: number;
    sortBy?: 'apr' | 'tvl' | 'volume' | 'fees';
    limit?: number;
  }): Promise<MeteoraPool[]> {
    let pools = await this.fetchAllPools();

    if (filters?.token) {
      const t = filters.token.toUpperCase();
      pools = pools.filter((p) =>
        p.name.toUpperCase().includes(t) ||
        p.mintX.toLowerCase() === filters.token!.toLowerCase() ||
        p.mintY.toLowerCase() === filters.token!.toLowerCase(),
      );
    }

    if (filters?.minTvl !== undefined) {
      pools = pools.filter((p) => p.tvlUsd >= filters.minTvl!);
    }

    if (filters?.minApr !== undefined) {
      pools = pools.filter((p) => p.apr >= filters.minApr!);
    }

    const sortBy = filters?.sortBy ?? 'apr';
    switch (sortBy) {
      case 'apr':
        pools.sort((a, b) => b.apr - a.apr);
        break;
      case 'tvl':
        pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
        break;
      case 'volume':
        pools.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case 'fees':
        pools.sort((a, b) => b.fees24h - a.fees24h);
        break;
    }

    const limit = filters?.limit ?? 100;
    return pools.slice(0, limit);
  }

  /**
   * Get a pool from cache (instant, no network).
   */
  getPoolFromCache(address: string): MeteoraPool | null {
    return this.poolCache.get(address) ?? null;
  }

  // ─── Bin Distribution ───────────────────────────────────────────────

  /**
   * Generate simulated bin distribution for a pool.
   * In production this would fetch on-chain bin data.
   */
  getBinDistribution(poolAddress: string): BinData[] | null {
    const pool = this.poolCache.get(poolAddress);
    if (!pool) return null;

    const activeBinId = Math.floor(Math.log(pool.currentPrice + 1) * 1000);
    const numBins = 25;
    const bins: BinData[] = [];
    let totalLiquidity = 0;

    for (let i = -Math.floor(numBins / 2); i <= Math.floor(numBins / 2); i++) {
      const binId = activeBinId + i * pool.binStep;
      const distance = Math.abs(i);
      // Gaussian-like distribution centered on active bin
      const weight = Math.exp(-0.5 * (distance / 5) ** 2);
      const liq = round2(pool.liquidity * weight * 0.04);
      totalLiquidity += liq;

      const priceFactor = Math.pow(1 + pool.binStep / 10000, i);
      const price = round6(pool.currentPrice * priceFactor);

      bins.push({
        binId,
        pricePerToken: price,
        liquidityX: round2(liq * 0.5),
        liquidityY: round2(liq * 0.5),
        totalLiquidity: liq,
        supplyPct: 0, // filled below
      });
    }

    // Calculate supply percentages
    for (const bin of bins) {
      bin.supplyPct = totalLiquidity > 0
        ? round4((bin.totalLiquidity / totalLiquidity) * 100)
        : 0;
    }

    return bins;
  }

  // ─── Position Management ────────────────────────────────────────────

  /**
   * Open a new liquidity position (paper/simulated).
   */
  openPosition(params: {
    agentId: string;
    poolAddress: string;
    strategy: LiquidityStrategy;
    depositAmountX: number;
    depositAmountY: number;
    lowerBinId?: number;
    upperBinId?: number;
  }): MeteoraPosition {
    const pool = this.poolCache.get(params.poolAddress);
    if (!pool) {
      throw new Error(`Pool not found: ${params.poolAddress}`);
    }

    const activeBinId = Math.floor(Math.log(pool.currentPrice + 1) * 1000);
    const rangeWidth = this.getStrategyRangeWidth(params.strategy, pool.binStep);
    const lowerBin = params.lowerBinId ?? (activeBinId - rangeWidth);
    const upperBin = params.upperBinId ?? (activeBinId + rangeWidth);

    const depositValueUsd = round2(
      params.depositAmountX * pool.currentPrice + params.depositAmountY,
    );

    const position: MeteoraPosition = {
      id: generatePositionId(),
      agentId: params.agentId,
      poolAddress: params.poolAddress,
      poolName: pool.name,
      strategy: params.strategy,
      depositedAmountX: params.depositAmountX,
      depositedAmountY: params.depositAmountY,
      depositedValueUsd: depositValueUsd,
      currentValueUsd: depositValueUsd,
      lowerBinId: lowerBin,
      upperBinId: upperBin,
      activeBinId,
      feesEarnedUsd: 0,
      feesClaimedUsd: 0,
      unclaimedFeesUsd: 0,
      impermanentLossUsd: 0,
      entryPrice: pool.currentPrice,
      currentPrice: pool.currentPrice,
      isInRange: true,
      autoCompound: false,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      status: 'active',
    };

    this.positions.set(position.id, position);
    return position;
  }

  /**
   * Get all positions for an agent.
   */
  getPositions(agentId: string): MeteoraPosition[] {
    return Array.from(this.positions.values())
      .filter((p) => p.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Get all positions (no agent filter).
   */
  getAllPositions(): MeteoraPosition[] {
    return Array.from(this.positions.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Get a position by ID.
   */
  getPosition(positionId: string): MeteoraPosition | null {
    return this.positions.get(positionId) ?? null;
  }

  /**
   * Close (remove liquidity from) a position.
   */
  closePosition(positionId: string): MeteoraPosition {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    if (position.status === 'closed') {
      throw new Error(`Position already closed: ${positionId}`);
    }

    // Simulate final value with some time-based fee accrual
    const hoursOpen = (Date.now() - new Date(position.createdAt).getTime()) / 3_600_000;
    const pool = this.poolCache.get(position.poolAddress);
    const feeRate = pool ? pool.baseFeePct / 100 : 0.0004;
    const simulatedFees = round2(position.depositedValueUsd * feeRate * Math.max(hoursOpen, 0.1));

    position.feesEarnedUsd = round2(position.feesEarnedUsd + simulatedFees);
    position.unclaimedFeesUsd = 0;
    position.feesClaimedUsd = round2(position.feesClaimedUsd + simulatedFees);
    position.currentValueUsd = round2(position.depositedValueUsd + simulatedFees - position.impermanentLossUsd);
    position.status = 'closed';
    position.updatedAt = isoNow();

    // Remove auto-compound config
    this.autoCompoundConfigs.delete(positionId);

    return position;
  }

  /**
   * Claim accrued fees from a position.
   */
  claimFees(positionId: string): { position: MeteoraPosition; claimedUsd: number } {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    if (position.status === 'closed') {
      throw new Error(`Cannot claim fees on closed position: ${positionId}`);
    }

    // Simulate fee accrual based on time and pool APR
    this.simulateFeeAccrual(position);

    const claimed = position.unclaimedFeesUsd;
    position.feesClaimedUsd = round2(position.feesClaimedUsd + claimed);
    position.unclaimedFeesUsd = 0;
    position.updatedAt = isoNow();

    return { position, claimedUsd: claimed };
  }

  // ─── Pool Analytics ─────────────────────────────────────────────────

  /**
   * Compute comprehensive analytics for a pool.
   */
  getPoolAnalytics(poolAddress: string): PoolAnalytics | null {
    const pool = this.poolCache.get(poolAddress);
    if (!pool) return null;

    const feeApr = pool.tvlUsd > 0
      ? round4((pool.fees24h * 365 / pool.tvlUsd) * 100)
      : 0;

    // Simulated 7d values (in production, would track historical data)
    const volume7d = round2(pool.volume24h * 6.8);
    const fees7d = round2(pool.fees24h * 6.8);

    // Concentration score: higher bin step = less concentrated = lower score
    const concentrationScore = round2(Math.max(0, 100 - pool.binStep * 0.8));

    // Bin utilization: percentage of bins with meaningful liquidity
    const bins = this.getBinDistribution(poolAddress);
    const activeBins = bins ? bins.filter((b) => b.totalLiquidity > 0).length : 0;
    const totalBins = bins ? bins.length : 1;
    const binUtilization = round4((activeBins / totalBins) * 100);

    const activeBinId = Math.floor(Math.log(pool.currentPrice + 1) * 1000);

    return {
      address: pool.address,
      name: pool.name,
      apr: pool.apr,
      apy: pool.apy,
      feeApr,
      volume24h: pool.volume24h,
      volume7d,
      fees24h: pool.fees24h,
      fees7d,
      tvlUsd: pool.tvlUsd,
      priceChange24hPct: round4((Math.random() - 0.5) * 8), // simulated
      binUtilization,
      activeBinId,
      binStep: pool.binStep,
      concentrationScore,
    };
  }

  /**
   * Get top pools ranked by APR.
   */
  getTopPools(opts?: {
    limit?: number;
    minTvl?: number;
    sortBy?: 'apr' | 'volume' | 'fees';
  }): TopPool[] {
    const limit = opts?.limit ?? 10;
    const minTvl = opts?.minTvl ?? 0;
    const sortBy = opts?.sortBy ?? 'apr';

    let pools = Array.from(this.poolCache.values())
      .filter((p) => p.tvlUsd >= minTvl);

    switch (sortBy) {
      case 'apr':
        pools.sort((a, b) => b.apr - a.apr);
        break;
      case 'volume':
        pools.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case 'fees':
        pools.sort((a, b) => b.fees24h - a.fees24h);
        break;
    }

    return pools.slice(0, limit).map((p) => ({
      address: p.address,
      name: p.name,
      apr: p.apr,
      apy: p.apy,
      tvlUsd: p.tvlUsd,
      volume24h: p.volume24h,
      fees24h: p.fees24h,
      riskScore: this.computePoolRiskScore(p),
    }));
  }

  /**
   * Estimate impermanent loss for a position or hypothetical scenario.
   */
  estimateIL(params: {
    poolAddress: string;
    entryPrice: number;
    currentPrice?: number;
    depositValueUsd: number;
    durationDays?: number;
  }): ILEstimate {
    const pool = this.poolCache.get(params.poolAddress);
    const currentPrice = params.currentPrice ?? pool?.currentPrice ?? params.entryPrice;
    const durationDays = params.durationDays ?? 30;

    const priceChangeRatio = currentPrice / params.entryPrice;

    // IL formula: IL = 2 × √(r) / (1 + r) - 1
    const sqrtR = Math.sqrt(priceChangeRatio);
    const ilFactor = (2 * sqrtR / (1 + priceChangeRatio)) - 1;
    const ilPct = Math.abs(ilFactor) * 100;

    const holdValueUsd = round2(params.depositValueUsd * (1 + priceChangeRatio) / 2);
    const lpValueUsd = round2(params.depositValueUsd * (2 * sqrtR / (1 + priceChangeRatio)));
    const ilUsd = round2(Math.abs(holdValueUsd - lpValueUsd));

    // Fee compensation needed
    const annualizedIl = durationDays > 0 ? ilPct / (durationDays / 365) : 0;
    const poolApr = pool?.apr ?? 0;
    const netReturn = round4(poolApr - annualizedIl);

    // Break-even calculation
    let breakEvenDays: number | null = null;
    if (poolApr > 0 && ilPct > 0) {
      const dailyFeeRate = poolApr / 100 / 365;
      breakEvenDays = Math.ceil(ilPct / 100 / dailyFeeRate);
    }

    return {
      poolAddress: params.poolAddress,
      entryPrice: params.entryPrice,
      currentPrice,
      priceChangeRatio: round4(priceChangeRatio),
      ilPct: round4(ilPct),
      ilUsd,
      holdValueUsd,
      lpValueUsd,
      feeCompensationNeeded: round4(annualizedIl),
      netReturn,
      breakEvenDays,
    };
  }

  // ─── Strategy Layer ─────────────────────────────────────────────────

  /**
   * Rebalance a position when price moves out of range.
   */
  rebalancePosition(positionId: string): RebalanceResult {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    if (position.status === 'closed') {
      throw new Error(`Cannot rebalance closed position: ${positionId}`);
    }

    const pool = this.poolCache.get(position.poolAddress);
    if (!pool) {
      throw new Error(`Pool not found for position: ${positionId}`);
    }

    const oldLowerBin = position.lowerBinId;
    const oldUpperBin = position.upperBinId;
    const currentActiveBin = Math.floor(Math.log(pool.currentPrice + 1) * 1000);

    const rangeWidth = this.getStrategyRangeWidth(position.strategy, pool.binStep);
    const newLowerBin = currentActiveBin - rangeWidth;
    const newUpperBin = currentActiveBin + rangeWidth;

    // Update position
    position.lowerBinId = newLowerBin;
    position.upperBinId = newUpperBin;
    position.activeBinId = currentActiveBin;
    position.currentPrice = pool.currentPrice;
    position.isInRange = true;
    position.updatedAt = isoNow();

    // Simulate fee accrual during rebalance
    this.simulateFeeAccrual(position);

    const estimatedGasCostUsd = round4(0.005 + Math.random() * 0.01);

    return {
      positionId,
      oldLowerBin: oldLowerBin,
      oldUpperBin: oldUpperBin,
      newLowerBin,
      newUpperBin,
      priceCurrent: pool.currentPrice,
      rebalancedAt: isoNow(),
      estimatedGasCostUsd,
      message: `Position rebalanced around price ${pool.currentPrice}. New range: bins [${newLowerBin}, ${newUpperBin}].`,
    };
  }

  /**
   * Enable or configure auto-compounding for a position.
   */
  configureAutoCompound(params: {
    positionId: string;
    enabled: boolean;
    intervalHours?: number;
  }): AutoCompoundConfig {
    const position = this.positions.get(params.positionId);
    if (!position) {
      throw new Error(`Position not found: ${params.positionId}`);
    }
    if (position.status === 'closed') {
      throw new Error(`Cannot auto-compound closed position: ${params.positionId}`);
    }

    const intervalHours = params.intervalHours ?? 24;
    const existingConfig = this.autoCompoundConfigs.get(params.positionId);

    // Calculate estimated APY boost from compounding
    const pool = this.poolCache.get(position.poolAddress);
    const baseApr = pool?.apr ?? 0;
    const compoundsPerYear = (365 * 24) / intervalHours;
    const effectiveApy = (Math.pow(1 + (baseApr / 100) / compoundsPerYear, compoundsPerYear) - 1) * 100;
    const apyBoost = round4(effectiveApy - baseApr);

    const config: AutoCompoundConfig = {
      positionId: params.positionId,
      enabled: params.enabled,
      intervalHours,
      compoundsExecuted: existingConfig?.compoundsExecuted ?? 0,
      totalCompoundedUsd: existingConfig?.totalCompoundedUsd ?? 0,
      nextCompoundAt: params.enabled
        ? new Date(Date.now() + intervalHours * 3_600_000).toISOString()
        : '',
      estimatedApyBoost: apyBoost,
    };

    position.autoCompound = params.enabled;
    position.updatedAt = isoNow();

    if (params.enabled) {
      this.autoCompoundConfigs.set(params.positionId, config);
    } else {
      this.autoCompoundConfigs.delete(params.positionId);
    }

    return config;
  }

  /**
   * Get auto-compound config for a position.
   */
  getAutoCompoundConfig(positionId: string): AutoCompoundConfig | null {
    return this.autoCompoundConfigs.get(positionId) ?? null;
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private getStrategyRangeWidth(strategy: LiquidityStrategy, binStep: number): number {
    // Range width in number of bins from center
    switch (strategy) {
      case 'spot':
        return Math.max(5, Math.floor(50 / binStep));
      case 'curve':
        return Math.max(10, Math.floor(100 / binStep));
      case 'bid-ask':
        return Math.max(3, Math.floor(30 / binStep));
    }
  }

  private simulateFeeAccrual(position: MeteoraPosition): void {
    const pool = this.poolCache.get(position.poolAddress);
    if (!pool) return;

    const hoursOpen = Math.max(
      (Date.now() - new Date(position.createdAt).getTime()) / 3_600_000,
      0.01,
    );

    // Hourly fee rate based on pool APR
    const hourlyRate = (pool.apr / 100) / (365 * 24);
    const inRangeMultiplier = position.isInRange ? 1.0 : 0.1;
    const strategyMultiplier = position.strategy === 'bid-ask' ? 1.3
      : position.strategy === 'spot' ? 1.0
      : 0.9;

    const totalFees = round2(
      position.depositedValueUsd * hourlyRate * hoursOpen * inRangeMultiplier * strategyMultiplier,
    );

    const alreadyClaimed = position.feesClaimedUsd;
    position.feesEarnedUsd = round2(Math.max(totalFees, position.feesEarnedUsd));
    position.unclaimedFeesUsd = round2(Math.max(0, position.feesEarnedUsd - alreadyClaimed));

    // Simulate IL based on price movement
    if (pool.currentPrice !== position.entryPrice && position.entryPrice > 0) {
      const priceRatio = pool.currentPrice / position.entryPrice;
      const sqrtR = Math.sqrt(priceRatio);
      const ilFactor = Math.abs((2 * sqrtR / (1 + priceRatio)) - 1);
      position.impermanentLossUsd = round2(position.depositedValueUsd * ilFactor);
    }

    position.currentValueUsd = round2(
      position.depositedValueUsd + position.feesEarnedUsd - position.impermanentLossUsd,
    );
    position.currentPrice = pool.currentPrice;

    // Check if position is still in range
    const currentActiveBin = Math.floor(Math.log(pool.currentPrice + 1) * 1000);
    position.activeBinId = currentActiveBin;
    position.isInRange = currentActiveBin >= position.lowerBinId && currentActiveBin <= position.upperBinId;
  }

  private computePoolRiskScore(pool: MeteoraPool): number {
    // Risk score 0-100 (higher = riskier)
    let score = 0;

    // TVL factor: lower TVL = riskier
    if (pool.tvlUsd < 1_000_000) score += 40;
    else if (pool.tvlUsd < 10_000_000) score += 25;
    else if (pool.tvlUsd < 50_000_000) score += 15;
    else score += 5;

    // Bin step factor: wider bins = more volatility exposure
    if (pool.binStep >= 80) score += 30;
    else if (pool.binStep >= 40) score += 20;
    else if (pool.binStep >= 20) score += 10;
    else score += 5;

    // APR factor: extremely high APR often means high risk
    if (pool.apr > 500) score += 25;
    else if (pool.apr > 200) score += 15;
    else if (pool.apr > 100) score += 10;
    else score += 5;

    return Math.min(100, score);
  }
}
