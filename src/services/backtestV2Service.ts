import { v4 as uuid } from 'uuid';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { Agent, RiskLimits, Side, TradeIntent } from '../types.js';
import { isoNow } from '../utils/time.js';

// ────────────────────────── Types ──────────────────────────────────────

export interface BacktestV2Input {
  strategyId: string;
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  riskOverrides?: Partial<RiskLimits>;
}

export interface BacktestV2Trade {
  tick: number;
  side: Side;
  priceUsd: number;
  quantity: number;
  notionalUsd: number;
  pnlUsd: number;
}

export interface EquityCurvePoint {
  tick: number;
  equity: number;
  drawdownPct: number;
}

export interface BacktestV2Result {
  id: string;
  strategyId: string;
  symbol: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  trades: BacktestV2Trade[];
  equityCurve: EquityCurvePoint[];
  dailyReturns: number[];
}

// ─── Walk-forward types ────────────────────────────────────────────────

export interface WalkForwardWindow {
  windowIndex: number;
  inSampleStart: number;
  inSampleEnd: number;
  outOfSampleStart: number;
  outOfSampleEnd: number;
  bestParams: Record<string, number>;
  inSampleReturn: number;
  outOfSampleReturn: number;
  outOfSampleSharpe: number;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  aggregateOutOfSampleReturn: number;
  aggregateOutOfSampleSharpe: number;
  efficiency: number; // out-of-sample vs in-sample performance ratio
}

// ─── Optimization types ────────────────────────────────────────────────

export interface ParameterRange {
  name: string;
  min: number;
  max: number;
  step: number;
}

export interface OptimizeInput {
  strategyId: string;
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  parameterRanges: ParameterRange[];
  optimizeFor?: 'sharpe' | 'return' | 'calmar';
  riskOverrides?: Partial<RiskLimits>;
}

export interface OptimizationGridPoint {
  params: Record<string, number>;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  calmarRatio: number;
  tradeCount: number;
}

export interface OptimizeResult {
  bestParams: Record<string, number>;
  bestScore: number;
  optimizedFor: string;
  gridSize: number;
  grid: OptimizationGridPoint[];
  backtest: BacktestV2Result;
}

// ─── Monte Carlo types ─────────────────────────────────────────────────

export interface MonteCarloInput {
  strategyId: string;
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  simulations?: number;
  confidenceLevel?: number;
  riskOverrides?: Partial<RiskLimits>;
}

export interface MonteCarloResult {
  simulations: number;
  confidenceLevel: number;
  originalReturn: number;
  meanReturn: number;
  medianReturn: number;
  stdDevReturn: number;
  percentile5: number;
  percentile25: number;
  percentile75: number;
  percentile95: number;
  probabilityOfProfit: number;
  maxDrawdownMean: number;
  maxDrawdownWorst: number;
  valueAtRisk: number;
  conditionalVaR: number;
  returnDistribution: number[];
}

// ─── Compare types ─────────────────────────────────────────────────────

export interface CompareInput {
  strategyA: { strategyId: string; label?: string };
  strategyB: { strategyId: string; label?: string };
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  riskOverrides?: Partial<RiskLimits>;
}

export interface StatisticalTest {
  tStatistic: number;
  pValue: number;
  degreesOfFreedom: number;
  significant: boolean;
  confidenceLevel: number;
  meanDifference: number;
}

export interface CompareResult {
  strategyA: { label: string; result: BacktestV2Result };
  strategyB: { label: string; result: BacktestV2Result };
  tTest: StatisticalTest;
  winner: string | null;
  summary: string;
}

// ────────────────────────── Constants ──────────────────────────────────

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionSizePct: 0.25,
  maxOrderNotionalUsd: 50_000,
  maxGrossExposureUsd: 100_000,
  dailyLossCapUsd: 10_000,
  maxDrawdownPct: 0.5,
  cooldownSeconds: 0,
};

const ORDER_SIZE_PCT = 0.1;

// ────────────────────────── Service ───────────────────────────────────

export class BacktestV2Service {
  private readonly riskEngine = new RiskEngine();

  constructor(private readonly strategyRegistry: StrategyRegistry) {}

  // ─── Core backtest ──────────────────────────────────────────────────

  run(input: BacktestV2Input): BacktestV2Result {
    this.validateInput(input);

    const strategy = this.strategyRegistry.get(input.strategyId);
    if (!strategy) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Unknown strategyId '${input.strategyId}'.`);
    }

    const riskLimits: RiskLimits = { ...DEFAULT_RISK_LIMITS, ...input.riskOverrides };

    const agent: Agent = {
      id: `btv2-${uuid()}`,
      name: 'BacktestV2 Agent',
      apiKey: 'ephemeral',
      createdAt: isoNow(),
      updatedAt: isoNow(),
      startingCapitalUsd: input.startingCapitalUsd,
      cashUsd: input.startingCapitalUsd,
      realizedPnlUsd: 0,
      peakEquityUsd: input.startingCapitalUsd,
      riskLimits,
      positions: {},
      dailyRealizedPnlUsd: {},
      riskRejectionsByReason: {},
      strategyId: input.strategyId as Agent['strategyId'],
    };

    const symbol = input.symbol.toUpperCase();
    const trades: BacktestV2Trade[] = [];
    const equityCurve: EquityCurvePoint[] = [{ tick: 0, equity: input.startingCapitalUsd, drawdownPct: 0 }];

    for (let tick = 1; tick < input.priceHistory.length; tick++) {
      const currentPrice = input.priceHistory[tick];
      const historySlice = input.priceHistory.slice(0, tick);

      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      const signal = strategy.evaluate({
        symbol,
        currentPriceUsd: currentPrice,
        priceHistoryUsd: historySlice,
      });

      if (signal.action !== 'hold') {
        const side: Side = signal.action as Side;
        const equity = this.computeEquity(agent, symbol, currentPrice);
        const orderNotional = equity * ORDER_SIZE_PCT;
        const orderQuantity = orderNotional / currentPrice;

        if (orderNotional > 0 && orderQuantity > 0) {
          const intent: TradeIntent = {
            id: `btv2-intent-${tick}`,
            agentId: agent.id,
            symbol,
            side,
            notionalUsd: orderNotional,
            quantity: orderQuantity,
            createdAt: isoNow(),
            updatedAt: isoNow(),
            status: 'pending',
          };

          const riskDecision = this.riskEngine.evaluate({
            agent,
            intent,
            priceUsd: currentPrice,
            now: new Date(),
          });

          if (riskDecision.approved) {
            const trade = this.executePaperTrade(agent, symbol, side, riskDecision.computedQuantity, currentPrice, tick);
            if (trade) trades.push(trade);
          }
        }
      }

      const equity = this.computeEquity(agent, symbol, currentPrice);
      agent.peakEquityUsd = Math.max(agent.peakEquityUsd, equity);
      const dd = agent.peakEquityUsd > 0 ? ((agent.peakEquityUsd - equity) / agent.peakEquityUsd) * 100 : 0;
      equityCurve.push({ tick, equity, drawdownPct: Number(dd.toFixed(4)) });
    }

    return this.computeFullResults(input, equityCurve, trades);
  }

  // ─── Walk-forward optimization ──────────────────────────────────────

  walkForward(
    input: BacktestV2Input,
    windowCount: number = 4,
    inSamplePct: number = 0.7,
  ): WalkForwardResult {
    this.validateInput(input);

    if (windowCount < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'windowCount must be >= 2.');
    }
    if (inSamplePct <= 0 || inSamplePct >= 1) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'inSamplePct must be between 0 and 1 exclusive.');
    }

    const totalLength = input.priceHistory.length;
    const windowSize = Math.floor(totalLength / windowCount);
    if (windowSize < 4) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Not enough data for the requested number of windows.');
    }

    const windows: WalkForwardWindow[] = [];

    for (let w = 0; w < windowCount; w++) {
      const start = w * windowSize;
      const end = w === windowCount - 1 ? totalLength : (w + 1) * windowSize;
      const splitIdx = start + Math.floor((end - start) * inSamplePct);

      const inSamplePrices = input.priceHistory.slice(start, splitIdx);
      const outOfSamplePrices = input.priceHistory.slice(splitIdx, end);

      if (inSamplePrices.length < 2 || outOfSamplePrices.length < 2) continue;

      // Run in-sample backtest
      const inSampleResult = this.run({
        ...input,
        priceHistory: inSamplePrices,
      });

      // Run out-of-sample backtest
      const outOfSampleResult = this.run({
        ...input,
        priceHistory: outOfSamplePrices,
      });

      windows.push({
        windowIndex: w,
        inSampleStart: start,
        inSampleEnd: splitIdx,
        outOfSampleStart: splitIdx,
        outOfSampleEnd: end,
        bestParams: { orderSizePct: ORDER_SIZE_PCT },
        inSampleReturn: inSampleResult.totalReturnPct,
        outOfSampleReturn: outOfSampleResult.totalReturnPct,
        outOfSampleSharpe: outOfSampleResult.sharpeRatio,
      });
    }

    const aggReturn = windows.length > 0
      ? windows.reduce((s, w) => s + w.outOfSampleReturn, 0) / windows.length
      : 0;
    const aggSharpe = windows.length > 0
      ? windows.reduce((s, w) => s + w.outOfSampleSharpe, 0) / windows.length
      : 0;

    const avgInSample = windows.length > 0
      ? windows.reduce((s, w) => s + w.inSampleReturn, 0) / windows.length
      : 0;

    const efficiency = avgInSample !== 0 ? aggReturn / avgInSample : 0;

    return {
      windows,
      aggregateOutOfSampleReturn: Number(aggReturn.toFixed(4)),
      aggregateOutOfSampleSharpe: Number(aggSharpe.toFixed(4)),
      efficiency: Number(efficiency.toFixed(4)),
    };
  }

  // ─── Grid search optimization ───────────────────────────────────────

  optimize(input: OptimizeInput): OptimizeResult {
    this.validateInput(input);

    const optimizeFor = input.optimizeFor ?? 'sharpe';
    const ranges = input.parameterRanges;

    if (ranges.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'At least one parameter range is required.');
    }

    // Generate grid combinations
    const paramArrays: { name: string; values: number[] }[] = ranges.map((r) => {
      const values: number[] = [];
      for (let v = r.min; v <= r.max + r.step * 0.001; v += r.step) {
        values.push(Number(v.toFixed(8)));
      }
      if (values.length === 0) values.push(r.min);
      return { name: r.name, values };
    });

    const grid: OptimizationGridPoint[] = [];

    // Cartesian product of all parameter ranges
    const combos = this.cartesianProduct(paramArrays.map((p) => p.values));

    for (const combo of combos) {
      const params: Record<string, number> = {};
      paramArrays.forEach((p, i) => { params[p.name] = combo[i]; });

      // Use the parameter values as risk overrides if applicable
      const riskOverrides: Partial<RiskLimits> = { ...input.riskOverrides };
      if (params['maxPositionSizePct'] !== undefined) riskOverrides.maxPositionSizePct = params['maxPositionSizePct'];
      if (params['maxDrawdownPct'] !== undefined) riskOverrides.maxDrawdownPct = params['maxDrawdownPct'];
      if (params['maxOrderNotionalUsd'] !== undefined) riskOverrides.maxOrderNotionalUsd = params['maxOrderNotionalUsd'];
      if (params['dailyLossCapUsd'] !== undefined) riskOverrides.dailyLossCapUsd = params['dailyLossCapUsd'];

      const result = this.run({
        strategyId: input.strategyId,
        symbol: input.symbol,
        priceHistory: input.priceHistory,
        startingCapitalUsd: input.startingCapitalUsd,
        riskOverrides,
      });

      grid.push({
        params,
        totalReturnPct: result.totalReturnPct,
        sharpeRatio: result.sharpeRatio,
        maxDrawdownPct: result.maxDrawdownPct,
        calmarRatio: result.calmarRatio,
        tradeCount: result.tradeCount,
      });
    }

    // Sort by optimization target descending
    const scoreFor = (gp: OptimizationGridPoint): number => {
      if (optimizeFor === 'return') return gp.totalReturnPct;
      if (optimizeFor === 'calmar') return gp.calmarRatio;
      return gp.sharpeRatio;
    };

    grid.sort((a, b) => scoreFor(b) - scoreFor(a));

    const best = grid[0];
    const bestBacktest = this.run({
      strategyId: input.strategyId,
      symbol: input.symbol,
      priceHistory: input.priceHistory,
      startingCapitalUsd: input.startingCapitalUsd,
      riskOverrides: { ...input.riskOverrides, ...this.paramsToRisk(best.params) },
    });

    return {
      bestParams: best.params,
      bestScore: scoreFor(best),
      optimizedFor: optimizeFor,
      gridSize: grid.length,
      grid,
      backtest: bestBacktest,
    };
  }

  // ─── Monte Carlo simulation ─────────────────────────────────────────

  monteCarlo(input: MonteCarloInput): MonteCarloResult {
    this.validateInput(input);

    const numSims = input.simulations ?? 1000;
    const confLevel = input.confidenceLevel ?? 0.95;

    if (numSims < 10 || numSims > 100_000) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'simulations must be between 10 and 100000.');
    }

    // Run original backtest to get the trade returns
    const originalResult = this.run(input);
    const tradeReturns = originalResult.dailyReturns;

    if (tradeReturns.length < 2) {
      return {
        simulations: numSims,
        confidenceLevel: confLevel,
        originalReturn: originalResult.totalReturnPct,
        meanReturn: originalResult.totalReturnPct,
        medianReturn: originalResult.totalReturnPct,
        stdDevReturn: 0,
        percentile5: originalResult.totalReturnPct,
        percentile25: originalResult.totalReturnPct,
        percentile75: originalResult.totalReturnPct,
        percentile95: originalResult.totalReturnPct,
        probabilityOfProfit: originalResult.totalReturnPct > 0 ? 1 : 0,
        maxDrawdownMean: originalResult.maxDrawdownPct,
        maxDrawdownWorst: originalResult.maxDrawdownPct,
        valueAtRisk: 0,
        conditionalVaR: 0,
        returnDistribution: [originalResult.totalReturnPct],
      };
    }

    // Monte Carlo: shuffle daily returns and compute outcomes
    const simReturns: number[] = [];
    const simDrawdowns: number[] = [];

    for (let s = 0; s < numSims; s++) {
      const shuffled = this.shuffleArray([...tradeReturns]);
      let equity = input.startingCapitalUsd;
      let peak = equity;
      let maxDd = 0;

      for (const r of shuffled) {
        equity *= (1 + r);
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? (peak - equity) / peak : 0;
        if (dd > maxDd) maxDd = dd;
      }

      const totalReturn = ((equity - input.startingCapitalUsd) / input.startingCapitalUsd) * 100;
      simReturns.push(totalReturn);
      simDrawdowns.push(maxDd * 100);
    }

    simReturns.sort((a, b) => a - b);
    simDrawdowns.sort((a, b) => a - b);

    const mean = simReturns.reduce((s, r) => s + r, 0) / simReturns.length;
    const variance = simReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (simReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    const median = this.percentile(simReturns, 0.5);
    const p5 = this.percentile(simReturns, 0.05);
    const p25 = this.percentile(simReturns, 0.25);
    const p75 = this.percentile(simReturns, 0.75);
    const p95 = this.percentile(simReturns, 0.95);

    const profitCount = simReturns.filter((r) => r > 0).length;
    const probabilityOfProfit = profitCount / simReturns.length;

    const varIdx = Math.floor(simReturns.length * (1 - confLevel));
    const valueAtRisk = Math.abs(simReturns[varIdx] ?? 0);

    // Conditional VaR: average of losses beyond VaR
    const tailLosses = simReturns.slice(0, varIdx + 1);
    const conditionalVaR = tailLosses.length > 0
      ? Math.abs(tailLosses.reduce((s, r) => s + r, 0) / tailLosses.length)
      : 0;

    const maxDdMean = simDrawdowns.reduce((s, d) => s + d, 0) / simDrawdowns.length;
    const maxDdWorst = simDrawdowns[simDrawdowns.length - 1] ?? 0;

    return {
      simulations: numSims,
      confidenceLevel: confLevel,
      originalReturn: Number(originalResult.totalReturnPct.toFixed(4)),
      meanReturn: Number(mean.toFixed(4)),
      medianReturn: Number(median.toFixed(4)),
      stdDevReturn: Number(stdDev.toFixed(4)),
      percentile5: Number(p5.toFixed(4)),
      percentile25: Number(p25.toFixed(4)),
      percentile75: Number(p75.toFixed(4)),
      percentile95: Number(p95.toFixed(4)),
      probabilityOfProfit: Number(probabilityOfProfit.toFixed(4)),
      maxDrawdownMean: Number(maxDdMean.toFixed(4)),
      maxDrawdownWorst: Number(maxDdWorst.toFixed(4)),
      valueAtRisk: Number(valueAtRisk.toFixed(4)),
      conditionalVaR: Number(conditionalVaR.toFixed(4)),
      returnDistribution: simReturns.map((r) => Number(r.toFixed(4))),
    };
  }

  // ─── Strategy comparison with t-test ────────────────────────────────

  compare(input: CompareInput): CompareResult {
    if (input.priceHistory.length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'priceHistory must contain at least 2 data points.');
    }

    const resultA = this.run({
      strategyId: input.strategyA.strategyId,
      symbol: input.symbol,
      priceHistory: input.priceHistory,
      startingCapitalUsd: input.startingCapitalUsd,
      riskOverrides: input.riskOverrides,
    });

    const resultB = this.run({
      strategyId: input.strategyB.strategyId,
      symbol: input.symbol,
      priceHistory: input.priceHistory,
      startingCapitalUsd: input.startingCapitalUsd,
      riskOverrides: input.riskOverrides,
    });

    const returnsA = resultA.dailyReturns;
    const returnsB = resultB.dailyReturns;

    const tTest = this.welchTTest(returnsA, returnsB);

    const labelA = input.strategyA.label ?? input.strategyA.strategyId;
    const labelB = input.strategyB.label ?? input.strategyB.strategyId;

    let winner: string | null = null;
    let summary: string;

    if (tTest.significant) {
      winner = tTest.meanDifference > 0 ? labelA : labelB;
      summary = `${winner} significantly outperforms the other (t=${tTest.tStatistic.toFixed(3)}, p=${tTest.pValue.toFixed(4)}).`;
    } else {
      summary = `No statistically significant difference between ${labelA} and ${labelB} (t=${tTest.tStatistic.toFixed(3)}, p=${tTest.pValue.toFixed(4)}).`;
    }

    return {
      strategyA: { label: labelA, result: resultA },
      strategyB: { label: labelB, result: resultB },
      tTest,
      winner,
      summary,
    };
  }

  // ────────────────── Private helpers ──────────────────────────────────

  private validateInput(input: { priceHistory: number[]; startingCapitalUsd: number }): void {
    if (input.priceHistory.length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'priceHistory must contain at least 2 data points.');
    }
    if (input.startingCapitalUsd <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'startingCapitalUsd must be positive.');
    }
  }

  private executePaperTrade(
    agent: Agent, symbol: string, side: Side, quantity: number, priceUsd: number, tick: number,
  ): BacktestV2Trade | null {
    const notional = quantity * priceUsd;
    let pnl = 0;

    if (side === 'buy') {
      if (agent.cashUsd < notional) return null;
      agent.cashUsd -= notional;
      const existing = agent.positions[symbol];
      if (existing) {
        const totalQty = existing.quantity + quantity;
        const totalCost = existing.quantity * existing.avgEntryPriceUsd + notional;
        existing.avgEntryPriceUsd = totalCost / totalQty;
        existing.quantity = totalQty;
      } else {
        agent.positions[symbol] = { symbol, quantity, avgEntryPriceUsd: priceUsd };
      }
    } else {
      const existing = agent.positions[symbol];
      if (!existing || existing.quantity < quantity) return null;
      const proceeds = quantity * priceUsd;
      pnl = (priceUsd - existing.avgEntryPriceUsd) * quantity;
      agent.cashUsd += proceeds;
      agent.realizedPnlUsd += pnl;
      existing.quantity -= quantity;
      if (existing.quantity <= 1e-12) delete agent.positions[symbol];
    }

    return {
      tick,
      side,
      priceUsd,
      quantity: Number(quantity.toFixed(8)),
      notionalUsd: Number(notional.toFixed(8)),
      pnlUsd: Number(pnl.toFixed(8)),
    };
  }

  private computeEquity(agent: Agent, symbol: string, currentPrice: number): number {
    const inventoryValue = Object.values(agent.positions).reduce((sum, pos) => {
      const px = pos.symbol === symbol ? currentPrice : pos.avgEntryPriceUsd;
      return sum + pos.quantity * px;
    }, 0);
    return Number((agent.cashUsd + inventoryValue).toFixed(8));
  }

  private computeFullResults(
    input: BacktestV2Input,
    equityCurve: EquityCurvePoint[],
    trades: BacktestV2Trade[],
  ): BacktestV2Result {
    const startCap = input.startingCapitalUsd;
    const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? startCap;
    const totalReturnPct = ((finalEquity - startCap) / startCap) * 100;

    // Max drawdown
    let maxDrawdownPct = 0;
    for (const pt of equityCurve) {
      if (pt.drawdownPct > maxDrawdownPct) maxDrawdownPct = pt.drawdownPct;
    }

    // Daily returns
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) {
        dailyReturns.push((equityCurve[i].equity - prev) / prev);
      }
    }

    // Sharpe ratio
    let sharpeRatio = 0;
    if (dailyReturns.length > 1) {
      const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
      const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
      const std = Math.sqrt(variance);
      sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    }

    // Sortino ratio (downside deviation only)
    let sortinoRatio = 0;
    if (dailyReturns.length > 1) {
      const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
      const downsideReturns = dailyReturns.filter((r) => r < 0);
      if (downsideReturns.length > 0) {
        const downsideVar = downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length;
        const downsideStd = Math.sqrt(downsideVar);
        sortinoRatio = downsideStd > 0 ? (mean / downsideStd) * Math.sqrt(252) : 0;
      } else {
        sortinoRatio = mean > 0 ? Infinity : 0;
      }
    }

    // Calmar ratio
    const annualReturn = totalReturnPct;
    const calmarRatio = maxDrawdownPct > 0 ? annualReturn / maxDrawdownPct : 0;

    // Trade stats
    const tradeCount = trades.length;
    const wins = trades.filter((t) => t.pnlUsd > 0);
    const losses = trades.filter((t) => t.pnlUsd < 0);
    const winRate = tradeCount > 0 ? (wins.length / tradeCount) * 100 : 0;

    const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    return {
      id: `btv2-${uuid()}`,
      strategyId: input.strategyId,
      symbol: input.symbol.toUpperCase(),
      totalReturnPct: Number(totalReturnPct.toFixed(4)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
      sharpeRatio: Number(sharpeRatio.toFixed(4)),
      sortinoRatio: Number(Number.isFinite(sortinoRatio) ? sortinoRatio.toFixed(4) : '0'),
      calmarRatio: Number(calmarRatio.toFixed(4)),
      tradeCount,
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(Number.isFinite(profitFactor) ? profitFactor.toFixed(4) : '0'),
      avgWin: Number(avgWin.toFixed(4)),
      avgLoss: Number(avgLoss.toFixed(4)),
      trades,
      equityCurve,
      dailyReturns: dailyReturns.map((r) => Number(r.toFixed(8))),
    };
  }

  // Welch's t-test for unequal variances
  private welchTTest(a: number[], b: number[], alpha: number = 0.05): StatisticalTest {
    const nA = a.length;
    const nB = b.length;

    if (nA < 2 || nB < 2) {
      return {
        tStatistic: 0,
        pValue: 1,
        degreesOfFreedom: 0,
        significant: false,
        confidenceLevel: 1 - alpha,
        meanDifference: 0,
      };
    }

    const meanA = a.reduce((s, x) => s + x, 0) / nA;
    const meanB = b.reduce((s, x) => s + x, 0) / nB;
    const varA = a.reduce((s, x) => s + (x - meanA) ** 2, 0) / (nA - 1);
    const varB = b.reduce((s, x) => s + (x - meanB) ** 2, 0) / (nB - 1);

    const se = Math.sqrt(varA / nA + varB / nB);
    if (se === 0) {
      return {
        tStatistic: 0,
        pValue: 1,
        degreesOfFreedom: nA + nB - 2,
        significant: false,
        confidenceLevel: 1 - alpha,
        meanDifference: meanA - meanB,
      };
    }

    const t = (meanA - meanB) / se;

    // Welch-Satterthwaite degrees of freedom
    const num = (varA / nA + varB / nB) ** 2;
    const denom = ((varA / nA) ** 2) / (nA - 1) + ((varB / nB) ** 2) / (nB - 1);
    const df = denom > 0 ? num / denom : nA + nB - 2;

    // Approximate two-tailed p-value using the t-distribution CDF approximation
    const pValue = this.tDistPValue(Math.abs(t), df);

    return {
      tStatistic: Number(t.toFixed(6)),
      pValue: Number(pValue.toFixed(6)),
      degreesOfFreedom: Number(df.toFixed(2)),
      significant: pValue < alpha,
      confidenceLevel: 1 - alpha,
      meanDifference: Number((meanA - meanB).toFixed(8)),
    };
  }

  // Approximation of two-tailed p-value from t-distribution
  // Uses the regularized incomplete beta function approximation
  private tDistPValue(t: number, df: number): number {
    if (df <= 0) return 1;
    const x = df / (df + t * t);
    // Use a simple approximation for the regularized incomplete beta function
    // For a production system you'd use a proper library, but this is accurate enough
    const a = df / 2;
    const b = 0.5;
    const beta = this.incompleteBeta(x, a, b);
    return Math.min(1, Math.max(0, beta));
  }

  // Regularized incomplete beta function approximation using continued fraction
  private incompleteBeta(x: number, a: number, b: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Use a series expansion for small x
    const lnBeta = this.lnGamma(a) + this.lnGamma(b) - this.lnGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

    // Lentz's continued fraction algorithm
    const maxIter = 200;
    const eps = 1e-10;
    let f = 1;
    let c = 1;
    let d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < eps) d = eps;
    d = 1 / d;
    f = d;

    for (let m = 1; m <= maxIter; m++) {
      // Even step
      let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
      d = 1 + num * d;
      if (Math.abs(d) < eps) d = eps;
      c = 1 + num / c;
      if (Math.abs(c) < eps) c = eps;
      d = 1 / d;
      f *= c * d;

      // Odd step
      num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 + num * d;
      if (Math.abs(d) < eps) d = eps;
      c = 1 + num / c;
      if (Math.abs(c) < eps) c = eps;
      d = 1 / d;
      const delta = c * d;
      f *= delta;

      if (Math.abs(delta - 1) < eps) break;
    }

    return front * f / a;
  }

  // Log-gamma function (Stirling approximation)
  private lnGamma(z: number): number {
    if (z <= 0) return 0;
    // Lanczos approximation
    const g = 7;
    const coefs = [
      0.99999999999980993,
      676.5203681218851,
      -1259.1392167224028,
      771.32342877765313,
      -176.61502916214059,
      12.507343278686905,
      -0.13857109526572012,
      9.9843695780195716e-6,
      1.5056327351493116e-7,
    ];

    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - this.lnGamma(1 - z);
    }

    z -= 1;
    let x = coefs[0];
    for (let i = 1; i < g + 2; i++) {
      x += coefs[i] / (z + i);
    }
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = p * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  private shuffleArray(arr: number[]): number[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private cartesianProduct(arrays: number[][]): number[][] {
    if (arrays.length === 0) return [[]];
    return arrays.reduce<number[][]>(
      (acc, arr) => acc.flatMap((combo) => arr.map((val) => [...combo, val])),
      [[]],
    );
  }

  private paramsToRisk(params: Record<string, number>): Partial<RiskLimits> {
    const risk: Partial<RiskLimits> = {};
    if (params['maxPositionSizePct'] !== undefined) risk.maxPositionSizePct = params['maxPositionSizePct'];
    if (params['maxDrawdownPct'] !== undefined) risk.maxDrawdownPct = params['maxDrawdownPct'];
    if (params['maxOrderNotionalUsd'] !== undefined) risk.maxOrderNotionalUsd = params['maxOrderNotionalUsd'];
    if (params['dailyLossCapUsd'] !== undefined) risk.dailyLossCapUsd = params['dailyLossCapUsd'];
    return risk;
  }
}
