/**
 * Strategy Comparison / A-B Testing Service.
 *
 * Compares two or more strategies against the same price data
 * by running backtests for each and comparing side-by-side.
 */

import { BacktestService, BacktestResult } from './backtestService.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';

export interface CompareInput {
  strategyIds: string[];
  priceHistory: number[];
  capitalUsd: number;
}

export interface StrategyComparisonResult {
  strategyId: string;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  tradeCount: number;
}

export interface ComparisonOutput {
  results: StrategyComparisonResult[];
  winner: StrategyComparisonResult | null;
}

export class StrategyCompareService {
  constructor(private readonly backtestService: BacktestService) {}

  /**
   * Compare multiple strategies against the same price data.
   */
  compareStrategies(input: CompareInput): ComparisonOutput {
    if (!input.strategyIds || input.strategyIds.length < 2) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'At least 2 strategyIds are required for comparison.',
      );
    }

    if (!input.priceHistory || input.priceHistory.length < 2) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'priceHistory must contain at least 2 data points.',
      );
    }

    if (!input.capitalUsd || input.capitalUsd <= 0) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'capitalUsd must be positive.',
      );
    }

    const results: StrategyComparisonResult[] = [];

    for (const strategyId of input.strategyIds) {
      const backtestResult: BacktestResult = this.backtestService.run({
        strategyId,
        symbol: 'SOL',
        priceHistory: input.priceHistory,
        startingCapitalUsd: input.capitalUsd,
      });

      results.push({
        strategyId,
        totalReturnPct: backtestResult.totalReturnPct,
        sharpeRatio: backtestResult.sharpeRatio,
        maxDrawdownPct: backtestResult.maxDrawdownPct,
        winRate: backtestResult.winRate,
        tradeCount: backtestResult.tradeCount,
      });
    }

    const winner = this.getBestStrategy(results);

    return { results, winner };
  }

  /**
   * Pick the best strategy based on risk-adjusted return (Sharpe ratio).
   * Falls back to total return if Sharpe ratios are equal.
   */
  getBestStrategy(results: StrategyComparisonResult[]): StrategyComparisonResult | null {
    if (results.length === 0) return null;

    let best = results[0];
    for (let i = 1; i < results.length; i++) {
      const candidate = results[i];
      // Primary: higher Sharpe ratio
      if (candidate.sharpeRatio > best.sharpeRatio) {
        best = candidate;
      } else if (candidate.sharpeRatio === best.sharpeRatio) {
        // Tiebreaker: higher total return
        if (candidate.totalReturnPct > best.totalReturnPct) {
          best = candidate;
        }
      }
    }

    return structuredClone(best);
  }
}
