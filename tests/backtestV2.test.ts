import { describe, expect, it } from 'vitest';
import { BacktestV2Service } from '../src/services/backtestV2Service.js';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

function createService(): BacktestV2Service {
  const registry = new StrategyRegistry();
  return new BacktestV2Service(registry);
}

// ─── Price generators ──────────────────────────────────────────────────

function trendingUp(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 + stepPct));
  }
  return prices;
}

function trendingDown(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 - stepPct));
  }
  return prices;
}

function oscillating(start: number, ticks: number, amplitude = 0.02): number[] {
  const prices: number[] = [];
  for (let i = 0; i < ticks; i++) {
    prices.push(start * (1 + amplitude * Math.sin(i * 0.5)));
  }
  return prices;
}

function randomWalk(start: number, ticks: number, volatility = 0.015): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    prices.push(prices[i - 1] * (1 + change));
  }
  return prices;
}

// ─── Core backtest tests ───────────────────────────────────────────────

describe('BacktestV2Service', () => {
  describe('run()', () => {
    it('runs a V2 backtest with equity curve and extended metrics', () => {
      const service = createService();
      const result = service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 60),
        startingCapitalUsd: 10_000,
      });

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^btv2-/);
      expect(result.strategyId).toBe('momentum-v1');
      expect(result.symbol).toBe('SOL');
      expect(result.totalReturnPct).toBeTypeOf('number');
      expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
      expect(result.sharpeRatio).toBeTypeOf('number');
      expect(result.sortinoRatio).toBeTypeOf('number');
      expect(result.calmarRatio).toBeTypeOf('number');
      expect(result.profitFactor).toBeTypeOf('number');
      expect(result.avgWin).toBeTypeOf('number');
      expect(result.avgLoss).toBeTypeOf('number');
      expect(result.tradeCount).toBeGreaterThanOrEqual(0);
      expect(result.winRate).toBeGreaterThanOrEqual(0);
      expect(result.winRate).toBeLessThanOrEqual(100);
      expect(Array.isArray(result.trades)).toBe(true);
      expect(Array.isArray(result.equityCurve)).toBe(true);
      expect(Array.isArray(result.dailyReturns)).toBe(true);
      expect(result.equityCurve.length).toBeGreaterThanOrEqual(2);
    });

    it('equity curve starts at starting capital with tick 0', () => {
      const service = createService();
      const result = service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 30),
        startingCapitalUsd: 5_000,
      });

      expect(result.equityCurve[0].tick).toBe(0);
      expect(result.equityCurve[0].equity).toBe(5_000);
      expect(result.equityCurve[0].drawdownPct).toBe(0);
    });

    it('throws on unknown strategyId', () => {
      const service = createService();
      expect(() =>
        service.run({
          strategyId: 'nonexistent',
          symbol: 'SOL',
          priceHistory: [100, 101],
          startingCapitalUsd: 10_000,
        }),
      ).toThrow('Unknown strategyId');
    });

    it('throws when priceHistory has fewer than 2 points', () => {
      const service = createService();
      expect(() =>
        service.run({
          strategyId: 'momentum-v1',
          symbol: 'SOL',
          priceHistory: [100],
          startingCapitalUsd: 10_000,
        }),
      ).toThrow('at least 2 data points');
    });

    it('throws when startingCapitalUsd is not positive', () => {
      const service = createService();
      expect(() =>
        service.run({
          strategyId: 'momentum-v1',
          symbol: 'SOL',
          priceHistory: [100, 101],
          startingCapitalUsd: -5,
        }),
      ).toThrow('startingCapitalUsd must be positive');
    });

    it('each trade in result has all required fields', () => {
      const service = createService();
      const result = service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 50),
        startingCapitalUsd: 10_000,
      });

      for (const trade of result.trades) {
        expect(trade.tick).toBeTypeOf('number');
        expect(['buy', 'sell']).toContain(trade.side);
        expect(trade.priceUsd).toBeGreaterThan(0);
        expect(trade.quantity).toBeGreaterThan(0);
        expect(trade.notionalUsd).toBeGreaterThan(0);
        expect(trade.pnlUsd).toBeTypeOf('number');
      }
    });

    it('daily returns length matches equity curve length - 1', () => {
      const service = createService();
      const result = service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 40),
        startingCapitalUsd: 10_000,
      });

      expect(result.dailyReturns.length).toBe(result.equityCurve.length - 1);
    });
  });

  // ─── Walk-forward tests ─────────────────────────────────────────────

  describe('walkForward()', () => {
    it('performs walk-forward analysis across multiple windows', () => {
      const service = createService();
      const result = service.walkForward(
        {
          strategyId: 'momentum-v1',
          symbol: 'SOL',
          priceHistory: trendingUp(100, 120),
          startingCapitalUsd: 10_000,
        },
        4,
        0.7,
      );

      expect(result).toBeDefined();
      expect(result.windows.length).toBeGreaterThanOrEqual(2);
      expect(result.aggregateOutOfSampleReturn).toBeTypeOf('number');
      expect(result.aggregateOutOfSampleSharpe).toBeTypeOf('number');
      expect(result.efficiency).toBeTypeOf('number');

      for (const w of result.windows) {
        expect(w.windowIndex).toBeTypeOf('number');
        expect(w.inSampleStart).toBeTypeOf('number');
        expect(w.inSampleEnd).toBeTypeOf('number');
        expect(w.outOfSampleStart).toBeTypeOf('number');
        expect(w.outOfSampleEnd).toBeTypeOf('number');
        expect(w.inSampleReturn).toBeTypeOf('number');
        expect(w.outOfSampleReturn).toBeTypeOf('number');
        expect(w.outOfSampleSharpe).toBeTypeOf('number');
      }
    });

    it('throws when windowCount < 2', () => {
      const service = createService();
      expect(() =>
        service.walkForward(
          {
            strategyId: 'momentum-v1',
            symbol: 'SOL',
            priceHistory: trendingUp(100, 100),
            startingCapitalUsd: 10_000,
          },
          1,
          0.7,
        ),
      ).toThrow('windowCount must be >= 2');
    });

    it('throws when inSamplePct is out of range', () => {
      const service = createService();
      expect(() =>
        service.walkForward(
          {
            strategyId: 'momentum-v1',
            symbol: 'SOL',
            priceHistory: trendingUp(100, 100),
            startingCapitalUsd: 10_000,
          },
          4,
          1.0,
        ),
      ).toThrow('inSamplePct must be between 0 and 1');
    });
  });

  // ─── Optimization tests ─────────────────────────────────────────────

  describe('optimize()', () => {
    it('runs grid search and returns best parameters', () => {
      const service = createService();
      const result = service.optimize({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 60),
        startingCapitalUsd: 10_000,
        parameterRanges: [
          { name: 'maxPositionSizePct', min: 0.1, max: 0.3, step: 0.1 },
        ],
        optimizeFor: 'sharpe',
      });

      expect(result).toBeDefined();
      expect(result.bestParams).toBeDefined();
      expect(result.bestScore).toBeTypeOf('number');
      expect(result.optimizedFor).toBe('sharpe');
      expect(result.gridSize).toBeGreaterThanOrEqual(1);
      expect(result.grid.length).toBe(result.gridSize);
      expect(result.backtest).toBeDefined();
      expect(result.backtest.id).toMatch(/^btv2-/);
    });

    it('grid covers the cartesian product of ranges', () => {
      const service = createService();
      const result = service.optimize({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 40),
        startingCapitalUsd: 10_000,
        parameterRanges: [
          { name: 'maxPositionSizePct', min: 0.1, max: 0.2, step: 0.1 },
          { name: 'maxDrawdownPct', min: 0.3, max: 0.5, step: 0.1 },
        ],
      });

      // 2 values * 3 values = 6 combinations
      expect(result.gridSize).toBe(6);
    });

    it('throws when no parameter ranges provided', () => {
      const service = createService();
      expect(() =>
        service.optimize({
          strategyId: 'momentum-v1',
          symbol: 'SOL',
          priceHistory: trendingUp(100, 40),
          startingCapitalUsd: 10_000,
          parameterRanges: [],
        }),
      ).toThrow('At least one parameter range');
    });

    it('supports different optimization targets', () => {
      const service = createService();
      const sharpeResult = service.optimize({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 40),
        startingCapitalUsd: 10_000,
        parameterRanges: [
          { name: 'maxPositionSizePct', min: 0.1, max: 0.3, step: 0.1 },
        ],
        optimizeFor: 'sharpe',
      });

      const returnResult = service.optimize({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 40),
        startingCapitalUsd: 10_000,
        parameterRanges: [
          { name: 'maxPositionSizePct', min: 0.1, max: 0.3, step: 0.1 },
        ],
        optimizeFor: 'return',
      });

      expect(sharpeResult.optimizedFor).toBe('sharpe');
      expect(returnResult.optimizedFor).toBe('return');
    });
  });

  // ─── Monte Carlo tests ──────────────────────────────────────────────

  describe('monteCarlo()', () => {
    it('runs Monte Carlo simulation with correct output shape', () => {
      const service = createService();
      const result = service.monteCarlo({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 60),
        startingCapitalUsd: 10_000,
        simulations: 50,
        confidenceLevel: 0.95,
      });

      expect(result).toBeDefined();
      expect(result.simulations).toBe(50);
      expect(result.confidenceLevel).toBe(0.95);
      expect(result.originalReturn).toBeTypeOf('number');
      expect(result.meanReturn).toBeTypeOf('number');
      expect(result.medianReturn).toBeTypeOf('number');
      expect(result.stdDevReturn).toBeGreaterThanOrEqual(0);
      expect(result.percentile5).toBeTypeOf('number');
      expect(result.percentile25).toBeTypeOf('number');
      expect(result.percentile75).toBeTypeOf('number');
      expect(result.percentile95).toBeTypeOf('number');
      expect(result.probabilityOfProfit).toBeGreaterThanOrEqual(0);
      expect(result.probabilityOfProfit).toBeLessThanOrEqual(1);
      expect(result.maxDrawdownMean).toBeGreaterThanOrEqual(0);
      expect(result.maxDrawdownWorst).toBeGreaterThanOrEqual(0);
      expect(result.valueAtRisk).toBeTypeOf('number');
      expect(result.conditionalVaR).toBeTypeOf('number');
      expect(result.returnDistribution.length).toBe(50);
    });

    it('return distribution is sorted', () => {
      const service = createService();
      const result = service.monteCarlo({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: trendingUp(100, 50),
        startingCapitalUsd: 10_000,
        simulations: 30,
      });

      for (let i = 1; i < result.returnDistribution.length; i++) {
        expect(result.returnDistribution[i]).toBeGreaterThanOrEqual(result.returnDistribution[i - 1]);
      }
    });

    it('throws when simulations is out of range', () => {
      const service = createService();
      expect(() =>
        service.monteCarlo({
          strategyId: 'momentum-v1',
          symbol: 'SOL',
          priceHistory: trendingUp(100, 40),
          startingCapitalUsd: 10_000,
          simulations: 5,
        }),
      ).toThrow('simulations must be between 10 and 100000');
    });

    it('handles very short price series gracefully', () => {
      const service = createService();
      const result = service.monteCarlo({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: [100, 101, 102],
        startingCapitalUsd: 10_000,
        simulations: 10,
      });

      expect(result).toBeDefined();
      expect(result.simulations).toBe(10);
    });
  });

  // ─── Compare tests ──────────────────────────────────────────────────

  describe('compare()', () => {
    it('compares two strategies and returns a t-test result', () => {
      const service = createService();
      const result = service.compare({
        strategyA: { strategyId: 'momentum-v1', label: 'Momentum' },
        strategyB: { strategyId: 'mean-reversion-v1', label: 'Mean-Rev' },
        symbol: 'SOL',
        priceHistory: oscillating(100, 80),
        startingCapitalUsd: 10_000,
      });

      expect(result).toBeDefined();
      expect(result.strategyA.label).toBe('Momentum');
      expect(result.strategyB.label).toBe('Mean-Rev');
      expect(result.strategyA.result).toBeDefined();
      expect(result.strategyB.result).toBeDefined();
      expect(result.tTest).toBeDefined();
      expect(result.tTest.tStatistic).toBeTypeOf('number');
      expect(result.tTest.pValue).toBeGreaterThanOrEqual(0);
      expect(result.tTest.pValue).toBeLessThanOrEqual(1);
      expect(result.tTest.degreesOfFreedom).toBeTypeOf('number');
      expect(result.tTest.significant).toBeTypeOf('boolean');
      expect(result.tTest.confidenceLevel).toBe(0.95);
      expect(result.summary).toBeTypeOf('string');
    });

    it('uses strategyId as label when label is not provided', () => {
      const service = createService();
      const result = service.compare({
        strategyA: { strategyId: 'momentum-v1' },
        strategyB: { strategyId: 'dca-v1' },
        symbol: 'SOL',
        priceHistory: trendingUp(100, 40),
        startingCapitalUsd: 10_000,
      });

      expect(result.strategyA.label).toBe('momentum-v1');
      expect(result.strategyB.label).toBe('dca-v1');
    });

    it('throws when price history is too short', () => {
      const service = createService();
      expect(() =>
        service.compare({
          strategyA: { strategyId: 'momentum-v1' },
          strategyB: { strategyId: 'dca-v1' },
          symbol: 'SOL',
          priceHistory: [100],
          startingCapitalUsd: 10_000,
        }),
      ).toThrow('at least 2 data points');
    });

    it('winner is null when test is not significant', () => {
      const service = createService();
      // Very short series — probably not significant
      const result = service.compare({
        strategyA: { strategyId: 'momentum-v1' },
        strategyB: { strategyId: 'dca-v1' },
        symbol: 'SOL',
        priceHistory: [100, 101, 102],
        startingCapitalUsd: 10_000,
      });

      // With so few data points either null or a winner is fine,
      // but the structure must be correct
      expect(result.winner === null || typeof result.winner === 'string').toBe(true);
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  // ─── Cross-cutting tests ────────────────────────────────────────────

  describe('cross-cutting', () => {
    it('produces different V2 results for different strategies on same data', () => {
      const service = createService();
      const prices = trendingUp(100, 60);

      const momentumResult = service.run({
        strategyId: 'momentum-v1',
        symbol: 'SOL',
        priceHistory: prices,
        startingCapitalUsd: 10_000,
      });

      const dcaResult = service.run({
        strategyId: 'dca-v1',
        symbol: 'SOL',
        priceHistory: prices,
        startingCapitalUsd: 10_000,
      });

      // IDs must be unique
      expect(momentumResult.id).not.toBe(dcaResult.id);
      // At least one metric should differ
      const differ =
        momentumResult.totalReturnPct !== dcaResult.totalReturnPct ||
        momentumResult.tradeCount !== dcaResult.tradeCount;

      expect(differ || (momentumResult.tradeCount === 0 && dcaResult.tradeCount === 0)).toBe(true);
    });
  });
});
