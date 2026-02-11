import { StrategyId } from '../../types.js';

export type StrategyAction = 'buy' | 'sell' | 'hold';

export interface StrategyInput {
  symbol: string;
  currentPriceUsd: number;
  priceHistoryUsd: number[];
}

export interface StrategySignal {
  action: StrategyAction;
  confidence: number;
  rationale: string;
}

export interface StrategyPlugin {
  id: StrategyId;
  name: string;
  description: string;
  evaluate(input: StrategyInput): StrategySignal;
}
