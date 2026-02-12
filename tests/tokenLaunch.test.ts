import { describe, expect, it, beforeEach } from 'vitest';
import {
  TokenLaunchService,
  spotPrice,
  computeBuyCost,
  computeSellProceeds,
} from '../src/services/tokenLaunchService.js';
import type { TokenLaunchConfig, CurveParameters } from '../src/services/tokenLaunchService.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function linearConfig(overrides?: Partial<TokenLaunchConfig>): TokenLaunchConfig {
  return {
    name: 'TestToken',
    symbol: 'TST',
    maxSupply: 1_000_000,
    initialPrice: 0.001,
    curveParams: { type: 'linear', slope: 0.000001 },
    creatorId: 'creator-1',
    ...overrides,
  };
}

function expConfig(overrides?: Partial<TokenLaunchConfig>): TokenLaunchConfig {
  return {
    name: 'ExpToken',
    symbol: 'EXP',
    maxSupply: 100_000,
    initialPrice: 0.01,
    curveParams: { type: 'exponential', slope: 0.00005 },
    creatorId: 'creator-2',
    ...overrides,
  };
}

function sigmoidConfig(overrides?: Partial<TokenLaunchConfig>): TokenLaunchConfig {
  return {
    name: 'SigToken',
    symbol: 'SIG',
    maxSupply: 500_000,
    initialPrice: 0.005,
    curveParams: { type: 'sigmoid', slope: 0.00002, midpoint: 0.5 },
    creatorId: 'creator-3',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('TokenLaunchService', () => {
  let service: TokenLaunchService;

  beforeEach(() => {
    service = new TokenLaunchService();
  });

  // ── Bonding Curve Math ───────────────────────────────────────────────

  describe('spotPrice', () => {
    it('computes linear spot price correctly', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.000001 };
      const p0 = spotPrice(0, 0.001, params, 1_000_000);
      const p500k = spotPrice(500_000, 0.001, params, 1_000_000);

      expect(p0).toBeCloseTo(0.001, 6);
      expect(p500k).toBeCloseTo(0.501, 4);
    });

    it('computes exponential spot price correctly', () => {
      const params: CurveParameters = { type: 'exponential', slope: 0.00005 };
      const p0 = spotPrice(0, 0.01, params, 100_000);
      const p10k = spotPrice(10_000, 0.01, params, 100_000);

      expect(p0).toBeCloseTo(0.01, 6);
      // e^(0.00005 * 10000) = e^0.5 ≈ 1.6487
      expect(p10k).toBeCloseTo(0.01 * Math.exp(0.5), 4);
    });

    it('computes sigmoid spot price correctly', () => {
      const params: CurveParameters = { type: 'sigmoid', slope: 0.00002, midpoint: 0.5 };
      const maxSupply = 500_000;
      const pMid = spotPrice(250_000, 0.005, params, maxSupply);
      const pLow = spotPrice(0, 0.005, params, maxSupply);

      // At midpoint, sigmoid = 0.5, so price should be halfway between initial and max
      expect(pMid).toBeGreaterThan(pLow);
    });

    it('returns initial price for negative supply', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.0001 };
      expect(spotPrice(-10, 1.0, params, 1000)).toBe(1.0);
    });
  });

  describe('computeBuyCost', () => {
    it('computes cost for linear curve buy', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.001 };
      const { totalCost, avgPrice } = computeBuyCost(0, 100, 1.0, params, 10_000);

      // Integral of (1.0 + 0.001*s) from 0 to 100 = 100 + 0.001 * (100^2/2) = 100 + 5 = 105
      expect(totalCost).toBeCloseTo(105, 1);
      expect(avgPrice).toBeCloseTo(1.05, 2);
    });

    it('returns zero cost for zero quantity', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.001 };
      const { totalCost, avgPrice } = computeBuyCost(0, 0, 1.0, params, 10_000);
      expect(totalCost).toBe(0);
      expect(avgPrice).toBe(0);
    });
  });

  describe('computeSellProceeds', () => {
    it('computes proceeds for linear curve sell', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.001 };
      const { totalProceeds } = computeSellProceeds(100, 100, 1.0, params, 10_000);

      // Same integral as buying from 0 to 100
      expect(totalProceeds).toBeCloseTo(105, 1);
    });

    it('sell proceeds equal buy cost for same range (no spread)', () => {
      const params: CurveParameters = { type: 'linear', slope: 0.001 };
      const buy = computeBuyCost(0, 50, 1.0, params, 10_000);
      const sell = computeSellProceeds(50, 50, 1.0, params, 10_000);

      expect(buy.totalCost).toBeCloseTo(sell.totalProceeds, 2);
    });
  });

  // ── Launch CRUD ─────────────────────────────────────────────────────

  describe('createLaunch', () => {
    it('creates a launch with correct config', () => {
      const launch = service.createLaunch(linearConfig());

      expect(launch.id).toBeTruthy();
      expect(launch.name).toBe('TestToken');
      expect(launch.symbol).toBe('TST');
      expect(launch.maxSupply).toBe(1_000_000);
      expect(launch.initialPrice).toBe(0.001);
      expect(launch.curveParams.type).toBe('linear');
      expect(launch.currentSupplySold).toBe(0);
      expect(launch.transactions).toHaveLength(0);
      expect(launch.creatorId).toBe('creator-1');
    });

    it('uppercases the symbol', () => {
      const launch = service.createLaunch(linearConfig({ symbol: 'abc' }));
      expect(launch.symbol).toBe('ABC');
    });
  });

  describe('getLaunch', () => {
    it('returns null for non-existent launch', () => {
      expect(service.getLaunch('non-existent')).toBeNull();
    });

    it('returns launch by id', () => {
      const created = service.createLaunch(linearConfig());
      const fetched = service.getLaunch(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });
  });

  describe('listLaunches', () => {
    it('lists all launches', () => {
      service.createLaunch(linearConfig({ name: 'First' }));
      service.createLaunch(expConfig({ name: 'Second' }));
      service.createLaunch(sigmoidConfig({ name: 'Third' }));

      const list = service.listLaunches();
      expect(list).toHaveLength(3);
      const names = list.map((l) => l.name);
      expect(names).toContain('First');
      expect(names).toContain('Second');
      expect(names).toContain('Third');
    });
  });

  // ── Buy / Sell ──────────────────────────────────────────────────────

  describe('buy', () => {
    it('buys tokens and increases supply', () => {
      const launch = service.createLaunch(linearConfig());
      const result = service.buy(launch.id, 'buyer-1', 1000);

      expect(result.transaction.side).toBe('buy');
      expect(result.transaction.quantity).toBe(1000);
      expect(result.totalCost).toBeGreaterThan(0);
      expect(result.avgPrice).toBeGreaterThan(0);
      expect(result.newSupplySold).toBe(1000);
      expect(result.newSpotPrice).toBeGreaterThan(launch.initialPrice);
    });

    it('throws when buying exceeds max supply', () => {
      const launch = service.createLaunch(linearConfig({ maxSupply: 100 }));
      expect(() => service.buy(launch.id, 'buyer-1', 101)).toThrow('Cannot buy');
    });

    it('throws for non-existent launch', () => {
      expect(() => service.buy('non-existent', 'buyer-1', 10)).toThrow('Launch not found');
    });

    it('throws for non-positive quantity', () => {
      const launch = service.createLaunch(linearConfig());
      expect(() => service.buy(launch.id, 'buyer-1', 0)).toThrow('Quantity must be positive');
    });

    it('sequential buys increase price on linear curve', () => {
      const launch = service.createLaunch(linearConfig());
      const buy1 = service.buy(launch.id, 'buyer-1', 10_000);
      const buy2 = service.buy(launch.id, 'buyer-2', 10_000);

      expect(buy2.avgPrice).toBeGreaterThan(buy1.avgPrice);
    });
  });

  describe('sell', () => {
    it('sells tokens and decreases supply', () => {
      const launch = service.createLaunch(linearConfig());
      service.buy(launch.id, 'buyer-1', 5000);
      const result = service.sell(launch.id, 'buyer-1', 2000);

      expect(result.transaction.side).toBe('sell');
      expect(result.transaction.quantity).toBe(2000);
      expect(result.totalProceeds).toBeGreaterThan(0);
      expect(result.newSupplySold).toBe(3000);
    });

    it('throws when selling more than circulating supply', () => {
      const launch = service.createLaunch(linearConfig());
      service.buy(launch.id, 'buyer-1', 100);
      expect(() => service.sell(launch.id, 'seller-1', 200)).toThrow('Cannot sell');
    });

    it('throws for non-existent launch', () => {
      expect(() => service.sell('non-existent', 'seller-1', 10)).toThrow('Launch not found');
    });
  });

  // ── Market Cap Estimation ──────────────────────────────────────────

  describe('estimateMarketCap', () => {
    it('returns market cap estimates at default supply levels', () => {
      const launch = service.createLaunch(linearConfig());
      const estimates = service.estimateMarketCap(launch.id);

      expect(estimates.length).toBe(6); // 0, 10%, 25%, 50%, 75%, 100%
      expect(estimates[0].supplyLevel).toBe(0);
      expect(estimates[0].marketCap).toBe(0); // 0 supply * any price = 0
      expect(estimates[5].supplyLevel).toBe(1_000_000);
      expect(estimates[5].marketCap).toBeGreaterThan(0);
    });

    it('returns estimates for custom supply levels', () => {
      const launch = service.createLaunch(linearConfig());
      const estimates = service.estimateMarketCap(launch.id, [0, 500, 1000]);

      expect(estimates).toHaveLength(3);
      expect(estimates[2].supplyLevel).toBe(1000);
    });

    it('market cap increases with supply on linear curve', () => {
      const launch = service.createLaunch(linearConfig());
      const estimates = service.estimateMarketCap(launch.id);

      for (let i = 1; i < estimates.length; i++) {
        expect(estimates[i].marketCap).toBeGreaterThanOrEqual(estimates[i - 1].marketCap);
      }
    });

    it('throws for non-existent launch', () => {
      expect(() => service.estimateMarketCap('non-existent')).toThrow('Launch not found');
    });
  });

  // ── Liquidity Pool ────────────────────────────────────────────────

  describe('createLiquidityPool', () => {
    it('creates a liquidity pool for a launch', () => {
      const launch = service.createLaunch(linearConfig());
      const pool = service.createLiquidityPool(launch.id, 'USDC', 100_000, 50_000);

      expect(pool.id).toBeTruthy();
      expect(pool.baseToken).toBe('TST');
      expect(pool.quoteToken).toBe('USDC');
      expect(pool.baseReserve).toBe(100_000);
      expect(pool.quoteReserve).toBe(50_000);
      expect(pool.lpTokenSupply).toBeCloseTo(Math.sqrt(100_000 * 50_000), 2);
    });

    it('prevents creating duplicate liquidity pools', () => {
      const launch = service.createLaunch(linearConfig());
      service.createLiquidityPool(launch.id, 'USDC', 1000, 500);

      expect(() => service.createLiquidityPool(launch.id, 'USDC', 1000, 500))
        .toThrow('Liquidity pool already exists');
    });

    it('rejects non-positive reserves', () => {
      const launch = service.createLaunch(linearConfig());
      expect(() => service.createLiquidityPool(launch.id, 'USDC', 0, 500))
        .toThrow('Reserves must be positive');
    });

    it('throws for non-existent launch', () => {
      expect(() => service.createLiquidityPool('non-existent', 'USDC', 1000, 500))
        .toThrow('Launch not found');
    });
  });

  // ── Analytics ─────────────────────────────────────────────────────

  describe('getAnalytics', () => {
    it('returns analytics with no trades', () => {
      const launch = service.createLaunch(linearConfig());
      const analytics = service.getAnalytics(launch.id);

      expect(analytics.launchId).toBe(launch.id);
      expect(analytics.symbol).toBe('TST');
      expect(analytics.transactionCount).toBe(0);
      expect(analytics.uniqueBuyers).toBe(0);
      expect(analytics.currentSupplySold).toBe(0);
      expect(analytics.priceTrajectory.length).toBeGreaterThan(0);
    });

    it('tracks unique buyers and volume after trades', () => {
      const launch = service.createLaunch(linearConfig());
      service.buy(launch.id, 'buyer-1', 1000);
      service.buy(launch.id, 'buyer-2', 2000);
      service.buy(launch.id, 'buyer-1', 500); // repeat buyer
      service.sell(launch.id, 'buyer-1', 200);

      const analytics = service.getAnalytics(launch.id);

      expect(analytics.uniqueBuyers).toBe(2);
      expect(analytics.transactionCount).toBe(4);
      expect(analytics.totalVolumeBought).toBe(3500);
      expect(analytics.totalVolumeSold).toBe(200);
      expect(analytics.netVolume).toBe(3300);
      expect(analytics.currentSupplySold).toBe(3300);
      expect(analytics.currentMarketCap).toBeGreaterThan(0);
    });

    it('generates price trajectory', () => {
      const launch = service.createLaunch(linearConfig());
      const analytics = service.getAnalytics(launch.id);

      expect(analytics.priceTrajectory.length).toBe(11); // 0..10 checkpoints
      expect(analytics.priceTrajectory[0].supply).toBe(0);
      expect(analytics.priceTrajectory[0].price).toBeCloseTo(0.001, 6);

      // Prices should increase on a linear curve
      for (let i = 1; i < analytics.priceTrajectory.length; i++) {
        expect(analytics.priceTrajectory[i].price).toBeGreaterThanOrEqual(
          analytics.priceTrajectory[i - 1].price,
        );
      }
    });

    it('throws for non-existent launch', () => {
      expect(() => service.getAnalytics('non-existent')).toThrow('Launch not found');
    });
  });

  // ── Exponential curve integration ─────────────────────────────────

  describe('exponential curve', () => {
    it('prices grow exponentially with supply', () => {
      const launch = service.createLaunch(expConfig());
      const buy1 = service.buy(launch.id, 'buyer-1', 1000);
      const buy2 = service.buy(launch.id, 'buyer-2', 1000);

      // On exponential curve, later buys are more expensive
      expect(buy2.avgPrice).toBeGreaterThan(buy1.avgPrice);
    });
  });

  // ── Sigmoid curve integration ──────────────────────────────────────

  describe('sigmoid curve', () => {
    it('sigmoid price increases with supply', () => {
      const launch = service.createLaunch(sigmoidConfig());
      const buy1 = service.buy(launch.id, 'buyer-1', 10_000);
      const buy2 = service.buy(launch.id, 'buyer-2', 10_000);

      expect(buy2.avgPrice).toBeGreaterThan(buy1.avgPrice);
    });
  });
});
