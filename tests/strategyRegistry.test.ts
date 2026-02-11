import { describe, expect, it } from 'vitest';
import { StrategyRegistry } from '../src/domain/strategy/strategyRegistry.js';

const upTrend = [100, 101, 102, 103, 104, 105, 106];

describe('StrategyRegistry', () => {
  const registry = new StrategyRegistry();

  it('momentum strategy buys into uptrend', () => {
    const signal = registry.evaluate('momentum-v1', {
      symbol: 'SOL',
      currentPriceUsd: 108,
      priceHistoryUsd: upTrend,
    });

    expect(signal.action).toBe('buy');
  });

  it('mean reversion strategy sells into uptrend stretch', () => {
    const signal = registry.evaluate('mean-reversion-v1', {
      symbol: 'SOL',
      currentPriceUsd: 108,
      priceHistoryUsd: upTrend,
    });

    expect(signal.action).toBe('sell');
  });

  it('falls back to default strategy for unknown id', () => {
    const signal = registry.evaluate('unknown-strategy', {
      symbol: 'SOL',
      currentPriceUsd: 108,
      priceHistoryUsd: upTrend,
    });

    expect(['buy', 'sell', 'hold']).toContain(signal.action);
  });
});
