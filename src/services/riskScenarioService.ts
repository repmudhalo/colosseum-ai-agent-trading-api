/**
 * Risk Scenario Simulator Service.
 *
 * Stress-tests portfolios with pre-built macro scenarios (2008 Financial Crisis,
 * COVID Crash, Terra/LUNA Collapse, FTX Collapse, ETH Merge), custom scenario
 * builder, Monte Carlo simulation, tail risk analysis, and recovery time estimation.
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface PrebuiltScenario {
  id: string;
  name: string;
  description: string;
  historicalDate: string;
  category: 'macro-crisis' | 'crypto-collapse' | 'structural-event';
  assetShocks: Record<string, number>;          // symbol → pct change (e.g. -0.55)
  volatilityMultiplier: number;                 // e.g. 3.0 = 3× normal vol
  liquidityDrainPct: number;                    // 0–1, portion of liquidity removed
  durationTicks: number;
}

export interface CustomScenarioInput {
  name: string;
  description?: string;
  assetShocks: Record<string, number>;
  volatilityMultiplier?: number;
  liquidityDrainPct?: number;
  durationTicks?: number;
}

export interface PortfolioInput {
  positions: Record<string, { symbol: string; quantity: number; avgEntryPriceUsd: number }>;
  cashUsd: number;
  marketPrices: Record<string, number>;
}

export interface ScenarioSimulationResult {
  id: string;
  scenarioId: string;
  scenarioName: string;
  preStress: PortfolioSnapshot;
  postStress: PortfolioSnapshot;
  impact: ScenarioImpact;
  equityCurve: EquityTick[];
  liquidityImpact: LiquidityImpact;
}

export interface PortfolioSnapshot {
  equityUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
}

export interface ScenarioImpact {
  equityChangeUsd: number;
  equityChangePct: number;
  maxDrawdownPct: number;
  volatilityMultiplier: number;
  positionsAffected: number;
  wouldLiquidate: boolean;
  riskBreaches: string[];
}

export interface EquityTick {
  tick: number;
  equityUsd: number;
  drawdownPct: number;
  prices: Record<string, number>;
  events: string[];
}

export interface LiquidityImpact {
  drainPct: number;
  estimatedSlippageBps: number;
  affectedAssets: string[];
}

export interface MonteCarloInput {
  positions: Record<string, { symbol: string; quantity: number; avgEntryPriceUsd: number }>;
  cashUsd: number;
  marketPrices: Record<string, number>;
  numSimulations?: number;
  numTicks?: number;
  annualVolatility?: number;
}

export interface MonteCarloResult {
  id: string;
  numSimulations: number;
  numTicks: number;
  percentiles: {
    p1: number;
    p5: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  expectedReturn: number;
  standardDeviation: number;
  sharpeRatio: number;
  maxDrawdownDistribution: {
    p1: number;
    p5: number;
    p50: number;
    p95: number;
    p99: number;
  };
  simulationPaths: number[][];   // subset of equity curves for visualization
  generatedAt: string;
}

export interface TailRiskResult {
  agentId: string;
  portfolioValueUsd: number;
  var1Pct: number;               // Value at Risk (1%)
  var5Pct: number;               // Value at Risk (5%)
  cvar1Pct: number;              // Conditional VaR (1%) — expected shortfall
  cvar5Pct: number;
  worstCaseUsd: number;
  worstCasePct: number;
  tailScenarios: Array<{
    scenarioName: string;
    impactPct: number;
    probability: string;
  }>;
  generatedAt: string;
}

export interface RecoveryEstimate {
  agentId: string;
  currentDrawdownPct: number;
  estimatedRecoveryTicks: number;
  estimatedRecoveryDays: number;
  recoveryProbability: number;
  recoveryPaths: {
    optimistic: number;           // ticks to recover in p90
    expected: number;             // ticks to recover in p50
    pessimistic: number;          // ticks to recover in p10
  };
  assumptions: string[];
  generatedAt: string;
}

// ─── Pre-built Macro Scenarios ──────────────────────────────────────────

const PREBUILT_SCENARIOS: PrebuiltScenario[] = [
  {
    id: 'financial-crisis-2008',
    name: '2008 Financial Crisis',
    description: 'Global financial crisis: equities fell ~55%, credit markets froze, extreme volatility. Simulates systemic risk cascade.',
    historicalDate: '2008-09-15',
    category: 'macro-crisis',
    assetShocks: { SOL: -0.65, BONK: -0.80, JUP: -0.70, USDC: 0 },
    volatilityMultiplier: 4.0,
    liquidityDrainPct: 0.60,
    durationTicks: 20,
  },
  {
    id: 'covid-crash-2020',
    name: 'COVID Crash (March 2020)',
    description: 'Pandemic-driven flash crash: S&P 500 dropped 34% in 23 days. Crypto fell 50%+ before recovery.',
    historicalDate: '2020-03-12',
    category: 'macro-crisis',
    assetShocks: { SOL: -0.50, BONK: -0.70, JUP: -0.55, USDC: 0 },
    volatilityMultiplier: 5.0,
    liquidityDrainPct: 0.45,
    durationTicks: 15,
  },
  {
    id: 'terra-luna-collapse',
    name: 'Terra/LUNA Collapse',
    description: 'UST depeg triggered a death spiral wiping $40B in value. LUNA dropped 99.9%. Contagion across DeFi.',
    historicalDate: '2022-05-09',
    category: 'crypto-collapse',
    assetShocks: { SOL: -0.45, BONK: -0.60, JUP: -0.50, USDC: -0.01 },
    volatilityMultiplier: 6.0,
    liquidityDrainPct: 0.70,
    durationTicks: 10,
  },
  {
    id: 'ftx-collapse',
    name: 'FTX Collapse',
    description: 'FTX exchange insolvency caused a systemic trust crisis. SOL dropped 60%+ due to Alameda ties.',
    historicalDate: '2022-11-08',
    category: 'crypto-collapse',
    assetShocks: { SOL: -0.60, BONK: -0.55, JUP: -0.50, USDC: 0 },
    volatilityMultiplier: 3.5,
    liquidityDrainPct: 0.55,
    durationTicks: 12,
  },
  {
    id: 'eth-merge',
    name: 'ETH Merge (Structural Event)',
    description: 'Ethereum\'s transition to PoS caused volatility spikes and temporary price dislocations across ecosystem.',
    historicalDate: '2022-09-15',
    category: 'structural-event',
    assetShocks: { SOL: -0.10, BONK: -0.20, JUP: -0.15, USDC: 0 },
    volatilityMultiplier: 2.0,
    liquidityDrainPct: 0.20,
    durationTicks: 8,
  },
];

const PREBUILT_MAP = new Map(PREBUILT_SCENARIOS.map((s) => [s.id, s]));

// ─── Helpers ────────────────────────────────────────────────────────────

function computeEquity(
  positions: Record<string, { quantity: number }>,
  prices: Record<string, number>,
  cashUsd: number,
): number {
  let val = 0;
  for (const [symbol, pos] of Object.entries(positions)) {
    val += pos.quantity * (prices[symbol] ?? 0);
  }
  return cashUsd + val;
}

function computePositionsValue(
  positions: Record<string, { quantity: number }>,
  prices: Record<string, number>,
): number {
  let val = 0;
  for (const [symbol, pos] of Object.entries(positions)) {
    val += pos.quantity * (prices[symbol] ?? 0);
  }
  return val;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Seeded PRNG for deterministic testing */
class SeededRandom {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  /** Box-Muller normal distribution */
  nextGaussian(): number {
    const u1 = this.next() || 0.0001;
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

// ─── Service ────────────────────────────────────────────────────────────

export class RiskScenarioService {
  private monteCarloResults: Map<string, MonteCarloResult> = new Map();

  constructor(private readonly store: StateStore) {}

  // ─── Pre-built Scenarios ────────────────────────────────────────────

  listPrebuiltScenarios(): Array<Omit<PrebuiltScenario, 'assetShocks' | 'volatilityMultiplier' | 'liquidityDrainPct' | 'durationTicks'> & { assetShocks: Record<string, number> }> {
    return PREBUILT_SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      historicalDate: s.historicalDate,
      category: s.category,
      assetShocks: { ...s.assetShocks },
    }));
  }

  // ─── Simulate Scenario ──────────────────────────────────────────────

  simulateScenario(
    scenarioId: string,
    portfolio: PortfolioInput,
  ): ScenarioSimulationResult {
    const scenario = PREBUILT_MAP.get(scenarioId);
    if (!scenario) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Unknown scenario: '${scenarioId}'.`);
    }
    return this._runScenario(scenario, portfolio);
  }

  // ─── Custom Scenario ────────────────────────────────────────────────

  buildCustomScenario(input: CustomScenarioInput): PrebuiltScenario {
    const id = `custom-${uuid().slice(0, 8)}`;
    return {
      id,
      name: input.name,
      description: input.description ?? 'Custom user-defined scenario',
      historicalDate: isoNow(),
      category: 'macro-crisis',
      assetShocks: { ...input.assetShocks },
      volatilityMultiplier: input.volatilityMultiplier ?? 1.0,
      liquidityDrainPct: input.liquidityDrainPct ?? 0,
      durationTicks: input.durationTicks ?? 10,
    };
  }

  simulateCustomScenario(
    input: CustomScenarioInput,
    portfolio: PortfolioInput,
  ): ScenarioSimulationResult {
    const scenario = this.buildCustomScenario(input);
    return this._runScenario(scenario, portfolio);
  }

  // ─── Monte Carlo ────────────────────────────────────────────────────

  runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
    const numSims = input.numSimulations ?? 1000;
    const numTicks = input.numTicks ?? 252; // 1 trading year
    const annualVol = input.annualVolatility ?? 0.80; // crypto default
    const tickVol = annualVol / Math.sqrt(numTicks);

    const startEquity = computeEquity(input.positions, input.marketPrices, input.cashUsd);
    const rng = new SeededRandom(42);

    const finalEquities: number[] = [];
    const maxDrawdowns: number[] = [];
    const savedPaths: number[][] = [];
    const pathsToSave = Math.min(numSims, 20);

    for (let sim = 0; sim < numSims; sim++) {
      const prices = { ...input.marketPrices };
      let peakEquity = startEquity;
      let maxDD = 0;
      const path: number[] = [startEquity];

      for (let t = 0; t < numTicks; t++) {
        for (const symbol of Object.keys(prices)) {
          const shock = rng.nextGaussian() * tickVol;
          prices[symbol] = Math.max(prices[symbol] * (1 + shock), 0.000001);
        }
        const equity = computeEquity(input.positions, prices, input.cashUsd);
        if (equity > peakEquity) peakEquity = equity;
        const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
        if (dd > maxDD) maxDD = dd;
        path.push(round4(equity));
      }

      const finalEq = path[path.length - 1];
      finalEquities.push(finalEq);
      maxDrawdowns.push(round4(maxDD * 100));
      if (sim < pathsToSave) savedPaths.push(path);
    }

    finalEquities.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);

    const mean = finalEquities.reduce((s, v) => s + v, 0) / finalEquities.length;
    const variance = finalEquities.reduce((s, v) => s + (v - mean) ** 2, 0) / finalEquities.length;
    const stdDev = Math.sqrt(variance);
    const expectedReturn = startEquity > 0 ? round4(((mean - startEquity) / startEquity) * 100) : 0;
    const sharpe = stdDev > 0 ? round4((mean - startEquity) / stdDev) : 0;

    const result: MonteCarloResult = {
      id: uuid(),
      numSimulations: numSims,
      numTicks,
      percentiles: {
        p1: round4(percentile(finalEquities, 1)),
        p5: round4(percentile(finalEquities, 5)),
        p10: round4(percentile(finalEquities, 10)),
        p25: round4(percentile(finalEquities, 25)),
        p50: round4(percentile(finalEquities, 50)),
        p75: round4(percentile(finalEquities, 75)),
        p90: round4(percentile(finalEquities, 90)),
        p95: round4(percentile(finalEquities, 95)),
        p99: round4(percentile(finalEquities, 99)),
      },
      expectedReturn,
      standardDeviation: round4(stdDev),
      sharpeRatio: sharpe,
      maxDrawdownDistribution: {
        p1: round4(percentile(maxDrawdowns, 1)),
        p5: round4(percentile(maxDrawdowns, 5)),
        p50: round4(percentile(maxDrawdowns, 50)),
        p95: round4(percentile(maxDrawdowns, 95)),
        p99: round4(percentile(maxDrawdowns, 99)),
      },
      simulationPaths: savedPaths,
      generatedAt: isoNow(),
    };

    this.monteCarloResults.set(result.id, result);
    return structuredClone(result);
  }

  // ─── Tail Risk ──────────────────────────────────────────────────────

  analyzeTailRisk(agentId: string): TailRiskResult {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent '${agentId}' not found.`);
    }

    const portfolio: PortfolioInput = {
      positions: agent.positions,
      cashUsd: agent.cashUsd,
      marketPrices: state.marketPricesUsd,
    };

    const mcResult = this.runMonteCarlo({
      ...portfolio,
      numSimulations: 5000,
      numTicks: 60,
      annualVolatility: 0.80,
    });

    const allFinals = mcResult.simulationPaths.map((p) => p[p.length - 1]);
    // Use percentiles from the full MC run
    const portfolioValue = computeEquity(agent.positions, state.marketPricesUsd, agent.cashUsd);

    const var1Pct = portfolioValue > 0 ? round4(((portfolioValue - mcResult.percentiles.p1) / portfolioValue) * 100) : 0;
    const var5Pct = portfolioValue > 0 ? round4(((portfolioValue - mcResult.percentiles.p5) / portfolioValue) * 100) : 0;

    // Conditional VaR (expected shortfall below VaR threshold)
    const threshold1 = mcResult.percentiles.p1;
    const threshold5 = mcResult.percentiles.p5;

    const below1 = allFinals.filter((v) => v <= threshold1);
    const below5 = allFinals.filter((v) => v <= threshold5);
    const avgBelow1 = below1.length > 0 ? below1.reduce((s, v) => s + v, 0) / below1.length : threshold1;
    const avgBelow5 = below5.length > 0 ? below5.reduce((s, v) => s + v, 0) / below5.length : threshold5;

    const cvar1Pct = portfolioValue > 0 ? round4(((portfolioValue - avgBelow1) / portfolioValue) * 100) : 0;
    const cvar5Pct = portfolioValue > 0 ? round4(((portfolioValue - avgBelow5) / portfolioValue) * 100) : 0;

    // Find worst case from saved paths
    const worstFinal = allFinals.length > 0 ? Math.min(...allFinals) : portfolioValue;
    const worstCaseUsd = round4(portfolioValue - worstFinal);
    const worstCasePct = portfolioValue > 0 ? round4((worstCaseUsd / portfolioValue) * 100) : 0;

    // Tail scenarios from prebuilt
    const tailScenarios = PREBUILT_SCENARIOS.slice(0, 4).map((s) => {
      const avgShock = Object.values(s.assetShocks).reduce((a, b) => a + b, 0) / Object.values(s.assetShocks).length;
      return {
        scenarioName: s.name,
        impactPct: round4(avgShock * 100),
        probability: s.category === 'crypto-collapse' ? 'rare (~1-5%)' : 'very rare (<1%)',
      };
    });

    return {
      agentId,
      portfolioValueUsd: round4(portfolioValue),
      var1Pct,
      var5Pct,
      cvar1Pct,
      cvar5Pct,
      worstCaseUsd,
      worstCasePct,
      tailScenarios,
      generatedAt: isoNow(),
    };
  }

  // ─── Recovery Estimation ────────────────────────────────────────────

  estimateRecovery(agentId: string): RecoveryEstimate {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent '${agentId}' not found.`);
    }

    const currentEquity = computeEquity(agent.positions, state.marketPricesUsd, agent.cashUsd);
    const peakEquity = agent.peakEquityUsd > 0 ? agent.peakEquityUsd : agent.startingCapitalUsd;
    const currentDrawdownPct = peakEquity > 0
      ? round4(Math.max(0, ((peakEquity - currentEquity) / peakEquity) * 100))
      : 0;

    if (currentDrawdownPct <= 0) {
      return {
        agentId,
        currentDrawdownPct: 0,
        estimatedRecoveryTicks: 0,
        estimatedRecoveryDays: 0,
        recoveryProbability: 1.0,
        recoveryPaths: { optimistic: 0, expected: 0, pessimistic: 0 },
        assumptions: ['Portfolio is at or above peak equity — no recovery needed.'],
        generatedAt: isoNow(),
      };
    }

    // Monte Carlo recovery simulation
    const rng = new SeededRandom(777);
    const dailyDrift = 0.0003; // slight positive drift
    const dailyVol = 0.05;    // daily volatility
    const maxTicks = 500;
    const numSims = 2000;
    const recoveryTicks: number[] = [];

    for (let sim = 0; sim < numSims; sim++) {
      let equity = currentEquity;
      let recovered = false;
      for (let t = 1; t <= maxTicks; t++) {
        const shock = rng.nextGaussian() * dailyVol + dailyDrift;
        equity *= (1 + shock);
        if (equity >= peakEquity) {
          recoveryTicks.push(t);
          recovered = true;
          break;
        }
      }
      if (!recovered) {
        recoveryTicks.push(maxTicks);
      }
    }

    recoveryTicks.sort((a, b) => a - b);
    const recoveredCount = recoveryTicks.filter((t) => t < maxTicks).length;

    const result: RecoveryEstimate = {
      agentId,
      currentDrawdownPct,
      estimatedRecoveryTicks: Math.round(percentile(recoveryTicks, 50)),
      estimatedRecoveryDays: Math.round(percentile(recoveryTicks, 50)),
      recoveryProbability: round4(recoveredCount / numSims),
      recoveryPaths: {
        optimistic: Math.round(percentile(recoveryTicks, 10)),
        expected: Math.round(percentile(recoveryTicks, 50)),
        pessimistic: Math.round(percentile(recoveryTicks, 90)),
      },
      assumptions: [
        `Daily volatility: ${(dailyVol * 100).toFixed(1)}%`,
        `Daily drift: ${(dailyDrift * 100).toFixed(2)}%`,
        `Max simulation horizon: ${maxTicks} ticks (days)`,
        `Number of simulations: ${numSims}`,
        `Current drawdown: ${currentDrawdownPct.toFixed(2)}%`,
      ],
      generatedAt: isoNow(),
    };

    return result;
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private _runScenario(
    scenario: PrebuiltScenario,
    portfolio: PortfolioInput,
  ): ScenarioSimulationResult {
    const { positions, cashUsd, marketPrices } = portfolio;
    const ticks = scenario.durationTicks;
    const currentPrices = { ...marketPrices };

    const preEquity = computeEquity(positions, currentPrices, cashUsd);
    const prePosValue = computePositionsValue(positions, currentPrices);

    const equityCurve: EquityTick[] = [];
    let maxDrawdownPct = 0;
    let wouldLiquidate = false;
    const riskBreaches: string[] = [];

    const rng = new SeededRandom(31337);

    for (let t = 1; t <= ticks; t++) {
      const events: string[] = [];

      // Apply per-tick shock + noise
      for (const symbol of Object.keys(currentPrices)) {
        const totalShock = scenario.assetShocks[symbol] ?? -0.10; // default shock
        const perTickShock = totalShock / ticks;
        const noise = rng.nextGaussian() * (0.01 * scenario.volatilityMultiplier);
        currentPrices[symbol] = Math.max(
          currentPrices[symbol] * (1 + perTickShock + noise),
          0.000001,
        );
      }

      // Liquidity drain event at midpoint
      if (t === Math.floor(ticks / 2) && scenario.liquidityDrainPct > 0.3) {
        events.push(`liquidity_drain_${(scenario.liquidityDrainPct * 100).toFixed(0)}pct`);
      }

      const equity = computeEquity(positions, currentPrices, cashUsd);
      const dd = preEquity > 0 ? Math.max(0, ((preEquity - equity) / preEquity) * 100) : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      if (dd > 50) {
        if (!riskBreaches.includes('severe_drawdown')) {
          riskBreaches.push('severe_drawdown');
          events.push('severe_drawdown');
        }
      }
      if (dd > 20) {
        if (!riskBreaches.includes('drawdown_warning')) {
          riskBreaches.push('drawdown_warning');
          events.push('drawdown_warning');
        }
      }
      if (equity <= 0) {
        wouldLiquidate = true;
        events.push('liquidation');
      }

      if (scenario.volatilityMultiplier >= 4.0) {
        if (!riskBreaches.includes('extreme_volatility')) {
          riskBreaches.push('extreme_volatility');
          events.push('extreme_volatility');
        }
      }

      equityCurve.push({
        tick: t,
        equityUsd: round4(equity),
        drawdownPct: round4(dd),
        prices: { ...currentPrices },
        events,
      });
    }

    const postEquity = computeEquity(positions, currentPrices, cashUsd);
    const postPosValue = computePositionsValue(positions, currentPrices);

    // Liquidity impact
    const slippageBps = Math.round(scenario.liquidityDrainPct * 500);
    const affectedAssets = Object.keys(scenario.assetShocks).filter(
      (s) => scenario.assetShocks[s] < -0.05,
    );

    return {
      id: uuid(),
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      preStress: {
        equityUsd: round4(preEquity),
        cashUsd,
        positionsValueUsd: round4(prePosValue),
      },
      postStress: {
        equityUsd: round4(postEquity),
        cashUsd,
        positionsValueUsd: round4(postPosValue),
      },
      impact: {
        equityChangeUsd: round4(postEquity - preEquity),
        equityChangePct: preEquity > 0 ? round4(((postEquity - preEquity) / preEquity) * 100) : 0,
        maxDrawdownPct: round4(maxDrawdownPct),
        volatilityMultiplier: scenario.volatilityMultiplier,
        positionsAffected: Object.keys(positions).length,
        wouldLiquidate,
        riskBreaches,
      },
      equityCurve,
      liquidityImpact: {
        drainPct: scenario.liquidityDrainPct,
        estimatedSlippageBps: slippageBps,
        affectedAssets,
      },
    };
  }
}
