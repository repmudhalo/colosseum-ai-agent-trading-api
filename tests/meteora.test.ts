import { describe, expect, it, beforeEach } from 'vitest';
import {
  MeteoraService,
  MeteoraPool,
  MeteoraPosition,
  PoolAnalytics,
  BinData,
  ILEstimate,
  TopPool,
  RebalanceResult,
  AutoCompoundConfig,
  LiquidityStrategy,
} from '../src/services/meteoraService.js';

function createService(): MeteoraService {
  return new MeteoraService({ skipApi: true }); // use seed data only in tests
}

const SEED_POOL_ADDRESS = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6'; // SOL-USDC
const SEED_POOL_2 = '7qbRF5N7gQDsEkPqW3KYiEk7VnBitq8F3Q7Z5LUz9WY'; // SOL-USDT
const SEED_POOL_BONK = '3NdXyE5bJxNj7TBkNgEfzgyrZh9AYbTMcGmAqAp3R7nv'; // BONK-SOL

describe('MeteoraService', () => {
  // ─── Pool Discovery ─────────────────────────────────────────────────

  describe('Pool Discovery', () => {
    it('listPools returns seeded pools', async () => {
      const svc = createService();
      const pools = await svc.listPools();

      expect(pools.length).toBeGreaterThanOrEqual(6);
      for (const pool of pools) {
        expect(pool).toHaveProperty('address');
        expect(pool).toHaveProperty('name');
        expect(pool).toHaveProperty('mintX');
        expect(pool).toHaveProperty('mintY');
        expect(pool).toHaveProperty('tvlUsd');
        expect(pool).toHaveProperty('apr');
        expect(pool).toHaveProperty('currentPrice');
        expect(pool.tvlUsd).toBeGreaterThan(0);
      }
    });

    it('listPools filters by token name', async () => {
      const svc = createService();
      const pools = await svc.listPools({ token: 'SOL' });

      expect(pools.length).toBeGreaterThanOrEqual(2);
      for (const pool of pools) {
        expect(pool.name.toUpperCase()).toContain('SOL');
      }
    });

    it('listPools filters by minTvl', async () => {
      const svc = createService();
      const pools = await svc.listPools({ minTvl: 50_000_000 });

      for (const pool of pools) {
        expect(pool.tvlUsd).toBeGreaterThanOrEqual(50_000_000);
      }
    });

    it('listPools filters by minApr', async () => {
      const svc = createService();
      const pools = await svc.listPools({ minApr: 200 });

      expect(pools.length).toBeGreaterThanOrEqual(1);
      for (const pool of pools) {
        expect(pool.apr).toBeGreaterThanOrEqual(200);
      }
    });

    it('listPools sorts by tvl descending', async () => {
      const svc = createService();
      const pools = await svc.listPools({ sortBy: 'tvl' });

      for (let i = 1; i < pools.length; i++) {
        expect(pools[i - 1].tvlUsd).toBeGreaterThanOrEqual(pools[i].tvlUsd);
      }
    });

    it('listPools sorts by apr descending', async () => {
      const svc = createService();
      const pools = await svc.listPools({ sortBy: 'apr' });

      for (let i = 1; i < pools.length; i++) {
        expect(pools[i - 1].apr).toBeGreaterThanOrEqual(pools[i].apr);
      }
    });

    it('listPools respects limit', async () => {
      const svc = createService();
      const pools = await svc.listPools({ limit: 3 });

      expect(pools.length).toBeLessThanOrEqual(3);
    });

    it('getPoolFromCache returns pool for known address', () => {
      const svc = createService();
      const pool = svc.getPoolFromCache(SEED_POOL_ADDRESS);

      expect(pool).not.toBeNull();
      expect(pool!.address).toBe(SEED_POOL_ADDRESS);
      expect(pool!.name).toBe('SOL-USDC');
    });

    it('getPoolFromCache returns null for unknown address', () => {
      const svc = createService();
      const pool = svc.getPoolFromCache('unknown_address');

      expect(pool).toBeNull();
    });
  });

  // ─── Bin Distribution ───────────────────────────────────────────────

  describe('Bin Distribution', () => {
    it('getBinDistribution returns bins for known pool', () => {
      const svc = createService();
      const bins = svc.getBinDistribution(SEED_POOL_ADDRESS);

      expect(bins).not.toBeNull();
      expect(bins!.length).toBeGreaterThan(0);

      for (const bin of bins!) {
        expect(bin).toHaveProperty('binId');
        expect(bin).toHaveProperty('pricePerToken');
        expect(bin).toHaveProperty('liquidityX');
        expect(bin).toHaveProperty('liquidityY');
        expect(bin).toHaveProperty('totalLiquidity');
        expect(bin).toHaveProperty('supplyPct');
        expect(bin.totalLiquidity).toBeGreaterThanOrEqual(0);
      }
    });

    it('getBinDistribution supply percentages sum to ~100', () => {
      const svc = createService();
      const bins = svc.getBinDistribution(SEED_POOL_ADDRESS);

      expect(bins).not.toBeNull();
      const totalPct = bins!.reduce((sum, b) => sum + b.supplyPct, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    });

    it('getBinDistribution returns null for unknown pool', () => {
      const svc = createService();
      const bins = svc.getBinDistribution('unknown');

      expect(bins).toBeNull();
    });

    it('center bin has the most liquidity', () => {
      const svc = createService();
      const bins = svc.getBinDistribution(SEED_POOL_ADDRESS)!;

      const centerIndex = Math.floor(bins.length / 2);
      const centerLiq = bins[centerIndex].totalLiquidity;

      // Center should have more than edge bins
      expect(centerLiq).toBeGreaterThan(bins[0].totalLiquidity);
      expect(centerLiq).toBeGreaterThan(bins[bins.length - 1].totalLiquidity);
    });
  });

  // ─── Position Management ────────────────────────────────────────────

  describe('Position Management', () => {
    it('openPosition creates a new position', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      expect(position.id).toMatch(/^met-pos-/);
      expect(position.agentId).toBe('agent-1');
      expect(position.poolAddress).toBe(SEED_POOL_ADDRESS);
      expect(position.poolName).toBe('SOL-USDC');
      expect(position.strategy).toBe('spot');
      expect(position.depositedAmountX).toBe(10);
      expect(position.depositedAmountY).toBe(1500);
      expect(position.depositedValueUsd).toBeGreaterThan(0);
      expect(position.status).toBe('active');
      expect(position.isInRange).toBe(true);
      expect(position.feesEarnedUsd).toBe(0);
    });

    it('openPosition throws for unknown pool', () => {
      const svc = createService();
      expect(() =>
        svc.openPosition({
          agentId: 'agent-1',
          poolAddress: 'unknown',
          strategy: 'spot',
          depositAmountX: 10,
          depositAmountY: 1500,
        }),
      ).toThrow('Pool not found');
    });

    it('getPositions returns positions for a specific agent', () => {
      const svc = createService();

      svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });
      svc.openPosition({
        agentId: 'agent-2',
        poolAddress: SEED_POOL_2,
        strategy: 'curve',
        depositAmountX: 5,
        depositAmountY: 800,
      });

      const agent1Positions = svc.getPositions('agent-1');
      expect(agent1Positions.length).toBe(1);
      expect(agent1Positions[0].agentId).toBe('agent-1');

      const agent2Positions = svc.getPositions('agent-2');
      expect(agent2Positions.length).toBe(1);
      expect(agent2Positions[0].agentId).toBe('agent-2');
    });

    it('getAllPositions returns all positions', () => {
      const svc = createService();

      svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });
      svc.openPosition({
        agentId: 'agent-2',
        poolAddress: SEED_POOL_2,
        strategy: 'bid-ask',
        depositAmountX: 5,
        depositAmountY: 800,
      });

      const all = svc.getAllPositions();
      expect(all.length).toBe(2);
    });

    it('getPosition returns single position by id', () => {
      const svc = createService();
      const created = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const fetched = svc.getPosition(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it('getPosition returns null for unknown id', () => {
      const svc = createService();
      expect(svc.getPosition('nonexistent')).toBeNull();
    });

    it('closePosition sets status to closed', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const closed = svc.closePosition(position.id);
      expect(closed.status).toBe('closed');
      expect(closed.unclaimedFeesUsd).toBe(0);
    });

    it('closePosition throws for unknown position', () => {
      const svc = createService();
      expect(() => svc.closePosition('nonexistent')).toThrow('Position not found');
    });

    it('closePosition throws for already closed position', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.closePosition(position.id);
      expect(() => svc.closePosition(position.id)).toThrow('already closed');
    });

    it('claimFees returns claimed amount', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const result = svc.claimFees(position.id);
      expect(result).toHaveProperty('position');
      expect(result).toHaveProperty('claimedUsd');
      expect(result.claimedUsd).toBeGreaterThanOrEqual(0);
      expect(result.position.unclaimedFeesUsd).toBe(0);
    });

    it('claimFees throws for closed position', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.closePosition(position.id);
      expect(() => svc.claimFees(position.id)).toThrow('closed position');
    });
  });

  // ─── Pool Analytics ─────────────────────────────────────────────────

  describe('Pool Analytics', () => {
    it('getPoolAnalytics returns detailed analytics', () => {
      const svc = createService();
      const analytics = svc.getPoolAnalytics(SEED_POOL_ADDRESS);

      expect(analytics).not.toBeNull();
      expect(analytics!.address).toBe(SEED_POOL_ADDRESS);
      expect(analytics!.name).toBe('SOL-USDC');
      expect(analytics!).toHaveProperty('apr');
      expect(analytics!).toHaveProperty('apy');
      expect(analytics!).toHaveProperty('feeApr');
      expect(analytics!).toHaveProperty('volume24h');
      expect(analytics!).toHaveProperty('volume7d');
      expect(analytics!).toHaveProperty('fees24h');
      expect(analytics!).toHaveProperty('fees7d');
      expect(analytics!).toHaveProperty('tvlUsd');
      expect(analytics!).toHaveProperty('binUtilization');
      expect(analytics!).toHaveProperty('concentrationScore');
      expect(analytics!.volume7d).toBeGreaterThan(analytics!.volume24h);
    });

    it('getPoolAnalytics returns null for unknown pool', () => {
      const svc = createService();
      expect(svc.getPoolAnalytics('unknown')).toBeNull();
    });

    it('getTopPools returns pools ranked by APR', () => {
      const svc = createService();
      const top = svc.getTopPools();

      expect(top.length).toBeGreaterThan(0);

      // Should be sorted by APR descending
      for (let i = 1; i < top.length; i++) {
        expect(top[i - 1].apr).toBeGreaterThanOrEqual(top[i].apr);
      }

      for (const pool of top) {
        expect(pool).toHaveProperty('address');
        expect(pool).toHaveProperty('name');
        expect(pool).toHaveProperty('apr');
        expect(pool).toHaveProperty('riskScore');
        expect(pool.riskScore).toBeGreaterThanOrEqual(0);
        expect(pool.riskScore).toBeLessThanOrEqual(100);
      }
    });

    it('getTopPools respects limit', () => {
      const svc = createService();
      const top = svc.getTopPools({ limit: 3 });

      expect(top.length).toBeLessThanOrEqual(3);
    });

    it('getTopPools filters by minTvl', () => {
      const svc = createService();
      const top = svc.getTopPools({ minTvl: 50_000_000 });

      for (const pool of top) {
        expect(pool.tvlUsd).toBeGreaterThanOrEqual(50_000_000);
      }
    });

    it('getTopPools sorts by volume', () => {
      const svc = createService();
      const top = svc.getTopPools({ sortBy: 'volume' });

      for (let i = 1; i < top.length; i++) {
        expect(top[i - 1].volume24h).toBeGreaterThanOrEqual(top[i].volume24h);
      }
    });
  });

  // ─── IL Estimation ──────────────────────────────────────────────────

  describe('IL Estimation', () => {
    it('estimateIL returns correct structure', () => {
      const svc = createService();
      const estimate = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 150,
        currentPrice: 170,
        depositValueUsd: 10_000,
      });

      expect(estimate).toHaveProperty('poolAddress', SEED_POOL_ADDRESS);
      expect(estimate).toHaveProperty('entryPrice', 150);
      expect(estimate).toHaveProperty('currentPrice', 170);
      expect(estimate).toHaveProperty('priceChangeRatio');
      expect(estimate).toHaveProperty('ilPct');
      expect(estimate).toHaveProperty('ilUsd');
      expect(estimate).toHaveProperty('holdValueUsd');
      expect(estimate).toHaveProperty('lpValueUsd');
      expect(estimate).toHaveProperty('feeCompensationNeeded');
      expect(estimate).toHaveProperty('netReturn');
      expect(estimate).toHaveProperty('breakEvenDays');
    });

    it('estimateIL with no price change gives zero IL', () => {
      const svc = createService();
      const estimate = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        currentPrice: 100,
        depositValueUsd: 10_000,
      });

      expect(estimate.priceChangeRatio).toBe(1);
      expect(estimate.ilPct).toBe(0);
      expect(estimate.ilUsd).toBe(0);
    });

    it('estimateIL increases with larger price divergence', () => {
      const svc = createService();

      const smallMove = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        currentPrice: 110,
        depositValueUsd: 10_000,
      });

      const bigMove = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        currentPrice: 200,
        depositValueUsd: 10_000,
      });

      expect(bigMove.ilPct).toBeGreaterThan(smallMove.ilPct);
      expect(bigMove.ilUsd).toBeGreaterThan(smallMove.ilUsd);
    });

    it('estimateIL calculates break-even days', () => {
      const svc = createService();
      const estimate = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        currentPrice: 150,
        depositValueUsd: 10_000,
        durationDays: 30,
      });

      // Pool has high APR so break-even should be calculable
      expect(estimate.breakEvenDays).not.toBeNull();
      expect(estimate.breakEvenDays!).toBeGreaterThan(0);
    });

    it('estimateIL uses pool current price as fallback', () => {
      const svc = createService();
      const pool = svc.getPoolFromCache(SEED_POOL_ADDRESS)!;

      const estimate = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        depositValueUsd: 10_000,
      });

      expect(estimate.currentPrice).toBe(pool.currentPrice);
    });
  });

  // ─── Strategy Layer ─────────────────────────────────────────────────

  describe('Strategy Layer', () => {
    it('rebalancePosition updates bin range', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const result = svc.rebalancePosition(position.id);

      expect(result).toHaveProperty('positionId', position.id);
      expect(result).toHaveProperty('oldLowerBin');
      expect(result).toHaveProperty('oldUpperBin');
      expect(result).toHaveProperty('newLowerBin');
      expect(result).toHaveProperty('newUpperBin');
      expect(result).toHaveProperty('priceCurrent');
      expect(result).toHaveProperty('rebalancedAt');
      expect(result).toHaveProperty('estimatedGasCostUsd');
      expect(result).toHaveProperty('message');
      expect(result.estimatedGasCostUsd).toBeGreaterThan(0);
    });

    it('rebalancePosition throws for unknown position', () => {
      const svc = createService();
      expect(() => svc.rebalancePosition('nonexistent')).toThrow('Position not found');
    });

    it('rebalancePosition throws for closed position', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.closePosition(position.id);
      expect(() => svc.rebalancePosition(position.id)).toThrow('closed position');
    });

    it('rebalancePosition sets isInRange to true', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'bid-ask',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.rebalancePosition(position.id);

      const updated = svc.getPosition(position.id)!;
      expect(updated.isInRange).toBe(true);
    });
  });

  // ─── Auto-Compound ──────────────────────────────────────────────────

  describe('Auto-Compound', () => {
    it('configureAutoCompound enables compounding', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const config = svc.configureAutoCompound({
        positionId: position.id,
        enabled: true,
        intervalHours: 12,
      });

      expect(config.positionId).toBe(position.id);
      expect(config.enabled).toBe(true);
      expect(config.intervalHours).toBe(12);
      expect(config.estimatedApyBoost).toBeGreaterThan(0);
      expect(config.nextCompoundAt).toBeTruthy();
    });

    it('configureAutoCompound disables compounding', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.configureAutoCompound({ positionId: position.id, enabled: true });
      const config = svc.configureAutoCompound({ positionId: position.id, enabled: false });

      expect(config.enabled).toBe(false);
      expect(config.nextCompoundAt).toBe('');
    });

    it('configureAutoCompound throws for unknown position', () => {
      const svc = createService();
      expect(() =>
        svc.configureAutoCompound({ positionId: 'nonexistent', enabled: true }),
      ).toThrow('Position not found');
    });

    it('configureAutoCompound throws for closed position', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.closePosition(position.id);
      expect(() =>
        svc.configureAutoCompound({ positionId: position.id, enabled: true }),
      ).toThrow('closed position');
    });

    it('getAutoCompoundConfig returns config when set', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.configureAutoCompound({ positionId: position.id, enabled: true, intervalHours: 6 });
      const config = svc.getAutoCompoundConfig(position.id);

      expect(config).not.toBeNull();
      expect(config!.intervalHours).toBe(6);
    });

    it('getAutoCompoundConfig returns null when not set', () => {
      const svc = createService();
      expect(svc.getAutoCompoundConfig('nonexistent')).toBeNull();
    });

    it('closing position removes auto-compound config', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      svc.configureAutoCompound({ positionId: position.id, enabled: true });
      svc.closePosition(position.id);

      expect(svc.getAutoCompoundConfig(position.id)).toBeNull();
    });
  });

  // ─── Strategy Variants ──────────────────────────────────────────────

  describe('Strategy Variants', () => {
    it.each<LiquidityStrategy>(['spot', 'curve', 'bid-ask'])(
      'openPosition supports %s strategy',
      (strategy) => {
        const svc = createService();
        const position = svc.openPosition({
          agentId: 'agent-1',
          poolAddress: SEED_POOL_ADDRESS,
          strategy,
          depositAmountX: 10,
          depositAmountY: 1500,
        });

        expect(position.strategy).toBe(strategy);
        expect(position.lowerBinId).toBeLessThan(position.upperBinId);
        expect(position.status).toBe('active');
      },
    );

    it('bid-ask strategy has narrower range than curve', () => {
      const svc = createService();

      const bidAsk = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'bid-ask',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const curve = svc.openPosition({
        agentId: 'agent-2',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'curve',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const bidAskRange = bidAsk.upperBinId - bidAsk.lowerBinId;
      const curveRange = curve.upperBinId - curve.lowerBinId;

      expect(bidAskRange).toBeLessThan(curveRange);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('multiple positions per agent work independently', () => {
      const svc = createService();

      const pos1 = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
      });

      const pos2 = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_2,
        strategy: 'curve',
        depositAmountX: 5,
        depositAmountY: 800,
      });

      svc.closePosition(pos1.id);

      const positions = svc.getPositions('agent-1');
      expect(positions.length).toBe(2);

      const active = positions.filter((p) => p.status === 'active');
      const closed = positions.filter((p) => p.status === 'closed');
      expect(active.length).toBe(1);
      expect(closed.length).toBe(1);
      expect(active[0].id).toBe(pos2.id);
    });

    it('IL estimate handles extreme price changes', () => {
      const svc = createService();

      const extreme = svc.estimateIL({
        poolAddress: SEED_POOL_ADDRESS,
        entryPrice: 100,
        currentPrice: 10,
        depositValueUsd: 10_000,
      });

      expect(extreme.ilPct).toBeGreaterThan(0);
      expect(extreme.ilUsd).toBeGreaterThan(0);
      expect(extreme.priceChangeRatio).toBeCloseTo(0.1, 4);
    });

    it('pool analytics concentration score varies by bin step', () => {
      const svc = createService();

      const analytics1 = svc.getPoolAnalytics(SEED_POOL_ADDRESS)!; // binStep=10
      const analytics2 = svc.getPoolAnalytics(SEED_POOL_BONK)!;   // binStep=80

      // Lower bin step = higher concentration
      expect(analytics1.concentrationScore).toBeGreaterThan(analytics2.concentrationScore);
    });

    it('openPosition with custom bin range', () => {
      const svc = createService();
      const position = svc.openPosition({
        agentId: 'agent-1',
        poolAddress: SEED_POOL_ADDRESS,
        strategy: 'spot',
        depositAmountX: 10,
        depositAmountY: 1500,
        lowerBinId: 100,
        upperBinId: 200,
      });

      expect(position.lowerBinId).toBe(100);
      expect(position.upperBinId).toBe(200);
    });
  });
});
