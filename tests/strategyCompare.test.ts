import { describe, expect, it } from 'vitest';
import { StrategyCompareService } from '../src/services/strategyCompareService.js';
import { BacktestService } from '../src/services/backtestService.js';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

function createService(): StrategyCompareService {
  const registry = new StrategyRegistry();
  const backtestService = new BacktestService(registry);
  return new StrategyCompareService(backtestService);
}

// Generate a trending-up price series
function trendingUp(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 + stepPct));
  }
  return prices;
}

// Generate an oscillating price series
function oscillating(start: number, ticks: number, amplitude = 0.02): number[] {
  const prices: number[] = [];
  for (let i = 0; i < ticks; i++) {
    prices.push(start * (1 + amplitude * Math.sin(i * 0.5)));
  }
  return prices;
}

describe('StrategyCompareService', () => {
  it('compares two strategies and returns results with a winner', () => {
    const service = createService();
    const prices = trendingUp(100, 50);

    const output = service.compareStrategies({
      strategyIds: ['momentum-v1', 'mean-reversion-v1'],
      priceHistory: prices,
      capitalUsd: 10_000,
    });

    expect(output.results).toHaveLength(2);
    expect(output.results[0].strategyId).toBe('momentum-v1');
    expect(output.results[1].strategyId).toBe('mean-reversion-v1');
    expect(output.winner).toBeDefined();
    expect(output.winner!.strategyId).toBeDefined();

    // Each result has all required metrics
    for (const result of output.results) {
      expect(result.totalReturnPct).toBeTypeOf('number');
      expect(result.sharpeRatio).toBeTypeOf('number');
      expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
      expect(result.winRate).toBeGreaterThanOrEqual(0);
      expect(result.winRate).toBeLessThanOrEqual(100);
      expect(result.tradeCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('compares more than two strategies', () => {
    const service = createService();
    const prices = oscillating(100, 50);

    const output = service.compareStrategies({
      strategyIds: ['momentum-v1', 'mean-reversion-v1', 'dca-v1'],
      priceHistory: prices,
      capitalUsd: 10_000,
    });

    expect(output.results).toHaveLength(3);
    expect(output.winner).toBeDefined();
    // Winner must be one of the compared strategies
    const winnerIds = output.results.map((r) => r.strategyId);
    expect(winnerIds).toContain(output.winner!.strategyId);
  });

  it('throws when fewer than 2 strategies are provided', () => {
    const service = createService();

    expect(() =>
      service.compareStrategies({
        strategyIds: ['momentum-v1'],
        priceHistory: [100, 101, 102],
        capitalUsd: 10_000,
      }),
    ).toThrow('At least 2 strategyIds');
  });

  it('throws on invalid priceHistory', () => {
    const service = createService();

    expect(() =>
      service.compareStrategies({
        strategyIds: ['momentum-v1', 'mean-reversion-v1'],
        priceHistory: [100],
        capitalUsd: 10_000,
      }),
    ).toThrow('at least 2 data points');
  });

  it('throws on non-positive capitalUsd', () => {
    const service = createService();

    expect(() =>
      service.compareStrategies({
        strategyIds: ['momentum-v1', 'mean-reversion-v1'],
        priceHistory: [100, 101],
        capitalUsd: 0,
      }),
    ).toThrow('capitalUsd must be positive');
  });

  it('throws when an unknown strategy is included', () => {
    const service = createService();

    expect(() =>
      service.compareStrategies({
        strategyIds: ['momentum-v1', 'nonexistent-strategy'],
        priceHistory: trendingUp(100, 30),
        capitalUsd: 10_000,
      }),
    ).toThrow('Unknown strategyId');
  });

  it('getBestStrategy picks highest Sharpe, falls back to return', () => {
    const service = createService();

    const results = [
      { strategyId: 'a', totalReturnPct: 10, sharpeRatio: 1.5, maxDrawdownPct: 5, winRate: 60, tradeCount: 10 },
      { strategyId: 'b', totalReturnPct: 15, sharpeRatio: 2.0, maxDrawdownPct: 3, winRate: 70, tradeCount: 8 },
      { strategyId: 'c', totalReturnPct: 20, sharpeRatio: 1.0, maxDrawdownPct: 8, winRate: 55, tradeCount: 12 },
    ];

    const winner = service.getBestStrategy(results);
    expect(winner).toBeDefined();
    expect(winner!.strategyId).toBe('b'); // Highest Sharpe
  });

  it('getBestStrategy returns null for empty results', () => {
    const service = createService();
    const winner = service.getBestStrategy([]);
    expect(winner).toBeNull();
  });
});
