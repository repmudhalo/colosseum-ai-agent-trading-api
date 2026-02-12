/**
 * Risk Scenario Stress Testing Service.
 *
 * Runs an agent's current portfolio through multiple stress scenarios
 * simultaneously and produces detailed impact analysis per scenario.
 * Built-in scenarios cover market crashes, flash liquidations,
 * correlation breaks, fee spikes, and oracle failures.
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface StressScenario {
  id: string;
  name: string;
  description: string;
  category: 'market' | 'liquidity' | 'correlation' | 'infrastructure' | 'oracle';
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  preStress: {
    equityUsd: number;
    cashUsd: number;
    positionsValueUsd: number;
  };
  postStress: {
    equityUsd: number;
    cashUsd: number;
    positionsValueUsd: number;
  };
  impact: {
    equityChangeUsd: number;
    equityChangePct: number;
    maxDrawdownPct: number;
    positionsAffected: number;
    wouldLiquidate: boolean;
    riskBreaches: string[];
  };
  ticks: TickSnapshot[];
}

export interface TickSnapshot {
  tick: number;
  prices: Record<string, number>;
  equityUsd: number;
  drawdownPct: number;
  events: string[];
}

export interface StressTestResult {
  id: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  scenarios: ScenarioResult[];
  summary: {
    worstScenarioId: string;
    worstEquityChangePct: number;
    scenariosWithLiquidation: number;
    totalRiskBreaches: number;
    overallRiskRating: 'low' | 'medium' | 'high' | 'critical';
  };
  startedAt: string;
  completedAt: string | null;
}

// ─── Built-in Scenarios ─────────────────────────────────────────────────

interface ScenarioEngine extends StressScenario {
  simulate: (
    positions: Record<string, { symbol: string; quantity: number; avgEntryPriceUsd: number }>,
    marketPrices: Record<string, number>,
    cashUsd: number,
    riskLimits: { maxDrawdownPct: number; maxGrossExposureUsd: number },
  ) => ScenarioResult;
}

function computeEquity(
  positions: Record<string, { quantity: number }>,
  prices: Record<string, number>,
  cashUsd: number,
): number {
  let posValue = 0;
  for (const [symbol, pos] of Object.entries(positions)) {
    const px = prices[symbol] ?? 0;
    posValue += pos.quantity * px;
  }
  return cashUsd + posValue;
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

const SCENARIO_ENGINES: ScenarioEngine[] = [
  {
    id: 'market-crash',
    name: 'Market Crash',
    description: 'All assets drop 40% over 10 ticks. Tests portfolio resilience to broad market downturn.',
    category: 'market',
    simulate(positions, marketPrices, cashUsd, riskLimits) {
      const totalTicks = 10;
      const dropPct = 0.40;
      const dropPerTick = dropPct / totalTicks;

      const currentPrices = { ...marketPrices };
      const preEquity = computeEquity(positions, currentPrices, cashUsd);
      const prePosValue = computePositionsValue(positions, currentPrices);
      const ticks: TickSnapshot[] = [];
      let maxDrawdownPct = 0;
      const riskBreaches: string[] = [];
      let wouldLiquidate = false;

      for (let t = 1; t <= totalTicks; t++) {
        const events: string[] = [];
        for (const symbol of Object.keys(currentPrices)) {
          currentPrices[symbol] = currentPrices[symbol] * (1 - dropPerTick);
        }

        const equity = computeEquity(positions, currentPrices, cashUsd);
        const dd = preEquity > 0 ? ((preEquity - equity) / preEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        if (dd / 100 >= riskLimits.maxDrawdownPct) {
          events.push('drawdown_limit_breached');
          if (!riskBreaches.includes('drawdown_limit_breached')) riskBreaches.push('drawdown_limit_breached');
        }
        if (equity <= 0) {
          wouldLiquidate = true;
          events.push('liquidation');
        }

        ticks.push({
          tick: t,
          prices: { ...currentPrices },
          equityUsd: Number(equity.toFixed(4)),
          drawdownPct: Number(dd.toFixed(4)),
          events,
        });
      }

      const postEquity = computeEquity(positions, currentPrices, cashUsd);
      const postPosValue = computePositionsValue(positions, currentPrices);

      return {
        scenarioId: 'market-crash',
        scenarioName: 'Market Crash',
        preStress: { equityUsd: Number(preEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(prePosValue.toFixed(4)) },
        postStress: { equityUsd: Number(postEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(postPosValue.toFixed(4)) },
        impact: {
          equityChangeUsd: Number((postEquity - preEquity).toFixed(4)),
          equityChangePct: preEquity > 0 ? Number((((postEquity - preEquity) / preEquity) * 100).toFixed(4)) : 0,
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
          positionsAffected: Object.keys(positions).length,
          wouldLiquidate,
          riskBreaches,
        },
        ticks,
      };
    },
  },
  {
    id: 'flash-liquidation',
    name: 'Flash Liquidation',
    description: 'SOL drops 60% in 5 ticks while other assets drop 10%. Tests concentrated position risk.',
    category: 'liquidity',
    simulate(positions, marketPrices, cashUsd, riskLimits) {
      const totalTicks = 5;
      const solDropPct = 0.60;
      const otherDropPct = 0.10;
      const solDropPerTick = solDropPct / totalTicks;
      const otherDropPerTick = otherDropPct / totalTicks;

      const currentPrices = { ...marketPrices };
      const preEquity = computeEquity(positions, currentPrices, cashUsd);
      const prePosValue = computePositionsValue(positions, currentPrices);
      const ticks: TickSnapshot[] = [];
      let maxDrawdownPct = 0;
      const riskBreaches: string[] = [];
      let wouldLiquidate = false;

      for (let t = 1; t <= totalTicks; t++) {
        const events: string[] = [];
        for (const symbol of Object.keys(currentPrices)) {
          if (symbol === 'SOL') {
            currentPrices[symbol] = currentPrices[symbol] * (1 - solDropPerTick);
          } else {
            currentPrices[symbol] = currentPrices[symbol] * (1 - otherDropPerTick);
          }
        }

        const equity = computeEquity(positions, currentPrices, cashUsd);
        const dd = preEquity > 0 ? ((preEquity - equity) / preEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        if (dd / 100 >= riskLimits.maxDrawdownPct) {
          events.push('drawdown_limit_breached');
          if (!riskBreaches.includes('drawdown_limit_breached')) riskBreaches.push('drawdown_limit_breached');
        }

        const grossExposure = computePositionsValue(positions, currentPrices);
        if (grossExposure > riskLimits.maxGrossExposureUsd) {
          events.push('gross_exposure_breached');
          if (!riskBreaches.includes('gross_exposure_breached')) riskBreaches.push('gross_exposure_breached');
        }

        if (equity <= 0) {
          wouldLiquidate = true;
          events.push('liquidation');
        }

        ticks.push({
          tick: t,
          prices: { ...currentPrices },
          equityUsd: Number(equity.toFixed(4)),
          drawdownPct: Number(dd.toFixed(4)),
          events,
        });
      }

      const postEquity = computeEquity(positions, currentPrices, cashUsd);
      const postPosValue = computePositionsValue(positions, currentPrices);

      return {
        scenarioId: 'flash-liquidation',
        scenarioName: 'Flash Liquidation',
        preStress: { equityUsd: Number(preEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(prePosValue.toFixed(4)) },
        postStress: { equityUsd: Number(postEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(postPosValue.toFixed(4)) },
        impact: {
          equityChangeUsd: Number((postEquity - preEquity).toFixed(4)),
          equityChangePct: preEquity > 0 ? Number((((postEquity - preEquity) / preEquity) * 100).toFixed(4)) : 0,
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
          positionsAffected: Object.keys(positions).filter((s) => currentPrices[s] !== undefined).length,
          wouldLiquidate,
          riskBreaches,
        },
        ticks,
      };
    },
  },
  {
    id: 'correlation-break',
    name: 'Correlation Break',
    description: 'Usually-correlated assets diverge: half drop 30%, half rise 20%. Tests diversification assumptions.',
    category: 'correlation',
    simulate(positions, marketPrices, cashUsd, riskLimits) {
      const totalTicks = 10;
      const symbols = Object.keys(marketPrices);
      const half = Math.ceil(symbols.length / 2);
      const dropSymbols = new Set(symbols.slice(0, half));

      const currentPrices = { ...marketPrices };
      const preEquity = computeEquity(positions, currentPrices, cashUsd);
      const prePosValue = computePositionsValue(positions, currentPrices);
      const ticks: TickSnapshot[] = [];
      let maxDrawdownPct = 0;
      const riskBreaches: string[] = [];
      let wouldLiquidate = false;

      for (let t = 1; t <= totalTicks; t++) {
        const events: string[] = [];
        for (const symbol of Object.keys(currentPrices)) {
          if (dropSymbols.has(symbol)) {
            currentPrices[symbol] = currentPrices[symbol] * (1 - 0.30 / totalTicks);
          } else {
            currentPrices[symbol] = currentPrices[symbol] * (1 + 0.20 / totalTicks);
          }
        }

        const equity = computeEquity(positions, currentPrices, cashUsd);
        const dd = preEquity > 0 ? Math.max(0, ((preEquity - equity) / preEquity) * 100) : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        if (dd / 100 >= riskLimits.maxDrawdownPct) {
          events.push('drawdown_limit_breached');
          if (!riskBreaches.includes('drawdown_limit_breached')) riskBreaches.push('drawdown_limit_breached');
        }
        if (equity <= 0) {
          wouldLiquidate = true;
          events.push('liquidation');
        }

        ticks.push({
          tick: t,
          prices: { ...currentPrices },
          equityUsd: Number(equity.toFixed(4)),
          drawdownPct: Number(dd.toFixed(4)),
          events,
        });
      }

      const postEquity = computeEquity(positions, currentPrices, cashUsd);
      const postPosValue = computePositionsValue(positions, currentPrices);

      return {
        scenarioId: 'correlation-break',
        scenarioName: 'Correlation Break',
        preStress: { equityUsd: Number(preEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(prePosValue.toFixed(4)) },
        postStress: { equityUsd: Number(postEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(postPosValue.toFixed(4)) },
        impact: {
          equityChangeUsd: Number((postEquity - preEquity).toFixed(4)),
          equityChangePct: preEquity > 0 ? Number((((postEquity - preEquity) / preEquity) * 100).toFixed(4)) : 0,
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
          positionsAffected: Object.keys(positions).length,
          wouldLiquidate,
          riskBreaches,
        },
        ticks,
      };
    },
  },
  {
    id: 'fee-spike',
    name: 'Fee Spike',
    description: 'Network fees increase 10x. Simulates impact on trading profitability assuming fee deductions.',
    category: 'infrastructure',
    simulate(positions, marketPrices, cashUsd, riskLimits) {
      const totalTicks = 10;
      const feeMultiplier = 10;
      const baseFeePerTxUsd = 0.01;
      const spikedFee = baseFeePerTxUsd * feeMultiplier;
      const positionCount = Object.keys(positions).length;

      const currentPrices = { ...marketPrices };
      const preEquity = computeEquity(positions, currentPrices, cashUsd);
      const prePosValue = computePositionsValue(positions, currentPrices);
      const ticks: TickSnapshot[] = [];
      let maxDrawdownPct = 0;
      const riskBreaches: string[] = [];
      let wouldLiquidate = false;
      let simulatedCash = cashUsd;

      for (let t = 1; t <= totalTicks; t++) {
        const events: string[] = [];
        const feesCost = spikedFee * Math.max(positionCount, 1);
        simulatedCash -= feesCost;
        events.push(`fee_deducted: $${feesCost.toFixed(4)}`);

        const equity = computeEquity(positions, currentPrices, simulatedCash);
        const dd = preEquity > 0 ? Math.max(0, ((preEquity - equity) / preEquity) * 100) : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        if (dd / 100 >= riskLimits.maxDrawdownPct) {
          events.push('drawdown_limit_breached');
          if (!riskBreaches.includes('drawdown_limit_breached')) riskBreaches.push('drawdown_limit_breached');
        }
        if (simulatedCash < 0) {
          events.push('negative_cash');
          if (!riskBreaches.includes('negative_cash')) riskBreaches.push('negative_cash');
        }
        if (equity <= 0) {
          wouldLiquidate = true;
          events.push('liquidation');
        }

        ticks.push({
          tick: t,
          prices: { ...currentPrices },
          equityUsd: Number(equity.toFixed(4)),
          drawdownPct: Number(dd.toFixed(4)),
          events,
        });
      }

      const postEquity = computeEquity(positions, currentPrices, simulatedCash);
      const postPosValue = computePositionsValue(positions, currentPrices);

      return {
        scenarioId: 'fee-spike',
        scenarioName: 'Fee Spike',
        preStress: { equityUsd: Number(preEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(prePosValue.toFixed(4)) },
        postStress: { equityUsd: Number(postEquity.toFixed(4)), cashUsd: Number(simulatedCash.toFixed(4)), positionsValueUsd: Number(postPosValue.toFixed(4)) },
        impact: {
          equityChangeUsd: Number((postEquity - preEquity).toFixed(4)),
          equityChangePct: preEquity > 0 ? Number((((postEquity - preEquity) / preEquity) * 100).toFixed(4)) : 0,
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
          positionsAffected: positionCount,
          wouldLiquidate,
          riskBreaches,
        },
        ticks,
      };
    },
  },
  {
    id: 'oracle-failure',
    name: 'Oracle Failure',
    description: 'Price feed goes stale for 30 ticks. Uses last known price, simulating blind trading risk.',
    category: 'oracle',
    simulate(positions, marketPrices, cashUsd, riskLimits) {
      const totalTicks = 30;
      const stalePrices = { ...marketPrices };
      const actualPrices = { ...marketPrices };

      const preEquity = computeEquity(positions, stalePrices, cashUsd);
      const prePosValue = computePositionsValue(positions, stalePrices);
      const ticks: TickSnapshot[] = [];
      let maxDrawdownPct = 0;
      const riskBreaches: string[] = [];
      let wouldLiquidate = false;

      let seed = 12345;
      const seededRand = () => {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return (seed >>> 0) / 0xffffffff;
      };

      for (let t = 1; t <= totalTicks; t++) {
        const events: string[] = [];
        events.push('oracle_stale');

        for (const symbol of Object.keys(actualPrices)) {
          const drift = (seededRand() * 0.06) - 0.03;
          actualPrices[symbol] = actualPrices[symbol] * (1 + drift);
        }

        const perceivedEquity = computeEquity(positions, stalePrices, cashUsd);
        const actualEquity = computeEquity(positions, actualPrices, cashUsd);
        const pricingError = Math.abs(perceivedEquity - actualEquity);

        if (pricingError > perceivedEquity * 0.05) {
          events.push('pricing_error_exceeds_5pct');
          if (!riskBreaches.includes('oracle_pricing_error')) riskBreaches.push('oracle_pricing_error');
        }

        const dd = preEquity > 0 ? Math.max(0, ((preEquity - actualEquity) / preEquity) * 100) : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        if (dd / 100 >= riskLimits.maxDrawdownPct) {
          events.push('drawdown_limit_breached');
          if (!riskBreaches.includes('drawdown_limit_breached')) riskBreaches.push('drawdown_limit_breached');
        }
        if (actualEquity <= 0) {
          wouldLiquidate = true;
          events.push('liquidation');
        }

        ticks.push({
          tick: t,
          prices: { ...actualPrices },
          equityUsd: Number(actualEquity.toFixed(4)),
          drawdownPct: Number(dd.toFixed(4)),
          events,
        });
      }

      const postEquity = computeEquity(positions, actualPrices, cashUsd);
      const postPosValue = computePositionsValue(positions, actualPrices);

      return {
        scenarioId: 'oracle-failure',
        scenarioName: 'Oracle Failure',
        preStress: { equityUsd: Number(preEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(prePosValue.toFixed(4)) },
        postStress: { equityUsd: Number(postEquity.toFixed(4)), cashUsd, positionsValueUsd: Number(postPosValue.toFixed(4)) },
        impact: {
          equityChangeUsd: Number((postEquity - preEquity).toFixed(4)),
          equityChangePct: preEquity > 0 ? Number((((postEquity - preEquity) / preEquity) * 100).toFixed(4)) : 0,
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
          positionsAffected: Object.keys(positions).length,
          wouldLiquidate,
          riskBreaches,
        },
        ticks,
      };
    },
  },
];

const SCENARIO_MAP = new Map(SCENARIO_ENGINES.map((s) => [s.id, s]));

// ─── Service ────────────────────────────────────────────────────────────

export class StressTestService {
  private results: Map<string, StressTestResult> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Run the agent's current portfolio through multiple stress scenarios.
   */
  runStressTest(agentId: string, scenarioIds?: string[]): StressTestResult {
    const state = this.store.snapshot();
    const agent = state.agents[agentId];

    if (!agent) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent '${agentId}' not found.`);
    }

    const selectedIds = scenarioIds && scenarioIds.length > 0
      ? scenarioIds
      : SCENARIO_ENGINES.map((s) => s.id);

    for (const sid of selectedIds) {
      if (!SCENARIO_MAP.has(sid)) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, `Unknown stress test scenario: '${sid}'.`);
      }
    }

    const testId = uuid();
    const result: StressTestResult = {
      id: testId,
      agentId,
      status: 'running',
      scenarios: [],
      summary: {
        worstScenarioId: '',
        worstEquityChangePct: 0,
        scenariosWithLiquidation: 0,
        totalRiskBreaches: 0,
        overallRiskRating: 'low',
      },
      startedAt: isoNow(),
      completedAt: null,
    };

    this.results.set(testId, result);

    const scenarioResults: ScenarioResult[] = [];
    for (const sid of selectedIds) {
      const engine = SCENARIO_MAP.get(sid)!;
      const scenarioResult = engine.simulate(
        agent.positions,
        state.marketPricesUsd,
        agent.cashUsd,
        {
          maxDrawdownPct: agent.riskLimits.maxDrawdownPct,
          maxGrossExposureUsd: agent.riskLimits.maxGrossExposureUsd,
        },
      );
      scenarioResults.push(scenarioResult);
    }

    let worstScenarioId = '';
    let worstChangePct = 0;
    let liquidationCount = 0;
    let totalBreaches = 0;

    for (const sr of scenarioResults) {
      if (sr.impact.equityChangePct < worstChangePct) {
        worstChangePct = sr.impact.equityChangePct;
        worstScenarioId = sr.scenarioId;
      }
      if (sr.impact.wouldLiquidate) liquidationCount++;
      totalBreaches += sr.impact.riskBreaches.length;
    }

    let riskRating: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (liquidationCount > 0) riskRating = 'critical';
    else if (worstChangePct < -30) riskRating = 'high';
    else if (worstChangePct < -15) riskRating = 'medium';

    result.scenarios = scenarioResults;
    result.status = 'completed';
    result.completedAt = isoNow();
    result.summary = {
      worstScenarioId,
      worstEquityChangePct: Number(worstChangePct.toFixed(4)),
      scenariosWithLiquidation: liquidationCount,
      totalRiskBreaches: totalBreaches,
      overallRiskRating: riskRating,
    };

    return structuredClone(result);
  }

  /**
   * Get stress test results by id.
   */
  getStressTestResults(testId: string): StressTestResult | null {
    const result = this.results.get(testId);
    return result ? structuredClone(result) : null;
  }

  /**
   * List available stress test scenarios.
   */
  listScenarios(): StressScenario[] {
    return SCENARIO_ENGINES.map(({ id, name, description, category }) => ({
      id,
      name,
      description,
      category,
    }));
  }
}
