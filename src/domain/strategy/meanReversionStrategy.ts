import { StrategyPlugin } from './types.js';

const avg = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

export const meanReversionStrategy: StrategyPlugin = {
  id: 'mean-reversion-v1',
  name: 'Mean Reversion v1',
  description: 'Takes the opposite side when current trend stretches away from moving average.',
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
    const stretch = (fast - slow) / slow;
    const confidence = Number(Math.min(1, Math.abs(stretch) * 150).toFixed(4));

    if (stretch > 0.003) {
      return {
        action: 'sell',
        confidence,
        rationale: `price_overextended_up:${stretch.toFixed(5)}`,
      };
    }

    if (stretch < -0.003) {
      return {
        action: 'buy',
        confidence,
        rationale: `price_overextended_down:${stretch.toFixed(5)}`,
      };
    }

    return {
      action: 'hold',
      confidence,
      rationale: `no_stretch:${stretch.toFixed(5)}`,
    };
  },
};
