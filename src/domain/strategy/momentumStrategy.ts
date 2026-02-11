import { StrategyPlugin } from './types.js';

const avg = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

export const momentumStrategy: StrategyPlugin = {
  id: 'momentum-v1',
  name: 'Momentum v1',
  description: 'Follows short-term trend using fast/slow moving-average crossover.',
  evaluate(input) {
    const history = input.priceHistoryUsd.filter((v) => Number.isFinite(v) && v > 0);
    const series = [...history, input.currentPriceUsd].slice(-10);

    if (series.length < 6) {
      return {
        action: 'hold',
        confidence: 0,
        rationale: 'insufficient_history',
      };
    }

    const fast = avg(series.slice(-3));
    const slow = avg(series.slice(-6));
    const drift = (fast - slow) / slow;
    const confidence = Number(Math.min(1, Math.abs(drift) * 150).toFixed(4));

    if (drift > 0.003) {
      return {
        action: 'buy',
        confidence,
        rationale: `fast_ma_above_slow_ma:${drift.toFixed(5)}`,
      };
    }

    if (drift < -0.003) {
      return {
        action: 'sell',
        confidence,
        rationale: `fast_ma_below_slow_ma:${drift.toFixed(5)}`,
      };
    }

    return {
      action: 'hold',
      confidence,
      rationale: `trend_flat:${drift.toFixed(5)}`,
    };
  },
};
