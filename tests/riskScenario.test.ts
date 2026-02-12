import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-risk-scenario',
    stateFile: `/tmp/colosseum-test-risk-scenario/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-risk-scenario/events-${Date.now()}.ndjson`,
  },
  worker: { intervalMs: 60_000, maxBatchSize: 10 },
  trading: {
    defaultStartingCapitalUsd: 10_000,
    defaultMode: 'paper' as const,
    liveEnabled: false,
    liveBroadcastEnabled: false,
    solanaRpcUrl: undefined,
    solanaPrivateKeyB58: undefined,
    jupiterQuoteUrl: 'https://lite-api.jup.ag/swap/v1/quote',
    jupiterSwapUrl: 'https://lite-api.jup.ag/swap/v1/swap',
    jupiterReferralAccount: undefined,
    jupiterPlatformFeeBps: 8,
    platformFeeBps: 8,
    supportedSymbols: ['SOL', 'USDC', 'BONK', 'JUP'],
    symbolToMint: {} as Record<string, string>,
    quoteRetryAttempts: 3,
    quoteRetryBaseDelayMs: 150,
    marketHistoryLimit: 100,
  },
  risk: {
    maxPositionSizePct: 0.25,
    maxOrderNotionalUsd: 2500,
    maxGrossExposureUsd: 7500,
    dailyLossCapUsd: 1000,
    maxDrawdownPct: 0.2,
    cooldownSeconds: 3,
  },
  rateLimit: { intentsPerMinute: 100 },
  payments: {
    x402RequiredPaths: [],
    x402PolicyFile: undefined,
  },
};

async function createTestApp(): Promise<AppContext> {
  const ctx = await buildApp(testConfig as any);
  return ctx;
}

function createAgentViaStore(ctx: AppContext, agentId: string): void {
  const state = ctx.stateStore.snapshot();
  state.agents[agentId] = {
    id: agentId,
    name: `Test Agent ${agentId}`,
    apiKey: `key-${agentId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000,
    cashUsd: 5_000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10_000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {
      SOL: { symbol: 'SOL', quantity: 30, avgEntryPriceUsd: 100 },
      BONK: { symbol: 'BONK', quantity: 50_000_000, avgEntryPriceUsd: 0.00002 },
    },
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
  };
  state.marketPricesUsd = { SOL: 100, USDC: 1, BONK: 0.00002, JUP: 0.8 };
  (ctx.stateStore as any).state = state;
}

describe('RiskScenarioService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.removeAllListeners();
    ctx = await createTestApp();
  });

  // ─── Pre-built Scenarios ──────────────────────────────────────────

  it('GET /risk-scenarios/prebuilt returns all 5 macro scenarios', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/risk-scenarios/prebuilt' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenarios).toHaveLength(5);

    const names = body.scenarios.map((s: any) => s.name);
    expect(names).toContain('2008 Financial Crisis');
    expect(names).toContain('COVID Crash (March 2020)');
    expect(names).toContain('Terra/LUNA Collapse');
    expect(names).toContain('FTX Collapse');
    expect(names).toContain('ETH Merge (Structural Event)');
  });

  it('prebuilt scenarios contain required fields', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/risk-scenarios/prebuilt' });
    const { scenarios } = res.json();

    for (const s of scenarios) {
      expect(s.id).toBeDefined();
      expect(s.name).toBeDefined();
      expect(s.description).toBeDefined();
      expect(s.historicalDate).toBeDefined();
      expect(s.category).toMatch(/^(macro-crisis|crypto-collapse|structural-event)$/);
      expect(s.assetShocks).toBeDefined();
    }
  });

  // ─── Simulate Scenario ────────────────────────────────────────────

  it('POST /risk-scenarios/simulate runs a prebuilt scenario', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/simulate',
      payload: {
        scenarioId: 'covid-crash-2020',
        portfolio: {
          positions: {
            SOL: { symbol: 'SOL', quantity: 50, avgEntryPriceUsd: 100 },
          },
          cashUsd: 2000,
          marketPrices: { SOL: 100, USDC: 1 },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.scenarioId).toBe('covid-crash-2020');
    expect(body.result.scenarioName).toBe('COVID Crash (March 2020)');
    expect(body.result.preStress.equityUsd).toBe(7000);
    expect(body.result.postStress.equityUsd).toBeLessThan(7000);
    expect(body.result.impact.equityChangePct).toBeLessThan(0);
    expect(body.result.equityCurve.length).toBe(15);
    expect(body.result.liquidityImpact).toBeDefined();
  });

  it('simulate rejects unknown scenario id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/simulate',
      payload: {
        scenarioId: 'nonexistent',
        portfolio: {
          positions: {},
          cashUsd: 1000,
          marketPrices: { SOL: 100 },
        },
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('simulate shows drawdown increasing over ticks', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/simulate',
      payload: {
        scenarioId: 'financial-crisis-2008',
        portfolio: {
          positions: {
            SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 },
          },
          cashUsd: 0,
          marketPrices: { SOL: 100 },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    const drawdowns = result.equityCurve.map((t: any) => t.drawdownPct);
    // Last drawdown should be larger than first
    expect(drawdowns[drawdowns.length - 1]).toBeGreaterThan(drawdowns[0]);
    expect(result.impact.maxDrawdownPct).toBeGreaterThan(20);
  });

  // ─── Custom Scenario ──────────────────────────────────────────────

  it('POST /risk-scenarios/custom builds and simulates custom scenario', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/custom',
      payload: {
        scenario: {
          name: 'Flash Crash',
          assetShocks: { SOL: -0.40, BONK: -0.90 },
          volatilityMultiplier: 3.0,
          liquidityDrainPct: 0.50,
          durationTicks: 5,
        },
        portfolio: {
          positions: {
            SOL: { symbol: 'SOL', quantity: 20, avgEntryPriceUsd: 100 },
            BONK: { symbol: 'BONK', quantity: 10_000_000, avgEntryPriceUsd: 0.00002 },
          },
          cashUsd: 1000,
          marketPrices: { SOL: 100, BONK: 0.00002 },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.scenarioId).toMatch(/^custom-/);
    expect(result.scenarioName).toBe('Flash Crash');
    expect(result.equityCurve).toHaveLength(5);
    expect(result.impact.equityChangePct).toBeLessThan(0);
    expect(result.liquidityImpact.drainPct).toBe(0.5);
  });

  it('custom scenario rejects missing name', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/custom',
      payload: {
        scenario: {
          assetShocks: { SOL: -0.30 },
        },
        portfolio: {
          positions: {},
          cashUsd: 1000,
          marketPrices: { SOL: 100 },
        },
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ─── Monte Carlo ──────────────────────────────────────────────────

  it('POST /risk-scenarios/monte-carlo runs portfolio simulation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/monte-carlo',
      payload: {
        positions: {
          SOL: { symbol: 'SOL', quantity: 50, avgEntryPriceUsd: 100 },
        },
        cashUsd: 3000,
        marketPrices: { SOL: 100 },
        numSimulations: 500,
        numTicks: 30,
        annualVolatility: 0.80,
      },
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.numSimulations).toBe(500);
    expect(result.numTicks).toBe(30);
    expect(result.percentiles.p1).toBeLessThan(result.percentiles.p99);
    expect(result.percentiles.p50).toBeDefined();
    expect(result.standardDeviation).toBeGreaterThan(0);
    expect(result.simulationPaths.length).toBeGreaterThan(0);
    expect(result.simulationPaths.length).toBeLessThanOrEqual(20);
    expect(result.maxDrawdownDistribution.p50).toBeGreaterThan(0);
  });

  it('Monte Carlo uses default parameters when not provided', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/monte-carlo',
      payload: {
        positions: {
          SOL: { symbol: 'SOL', quantity: 10, avgEntryPriceUsd: 100 },
        },
        cashUsd: 500,
        marketPrices: { SOL: 100 },
      },
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.numSimulations).toBe(1000);
    expect(result.numTicks).toBe(252);
  });

  it('Monte Carlo percentiles are monotonically increasing', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/monte-carlo',
      payload: {
        positions: {
          SOL: { symbol: 'SOL', quantity: 50, avgEntryPriceUsd: 100 },
        },
        cashUsd: 1000,
        marketPrices: { SOL: 100 },
        numSimulations: 500,
        numTicks: 50,
      },
    });

    const { result } = res.json();
    const p = result.percentiles;
    expect(p.p1).toBeLessThanOrEqual(p.p5);
    expect(p.p5).toBeLessThanOrEqual(p.p10);
    expect(p.p10).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p90);
    expect(p.p90).toBeLessThanOrEqual(p.p95);
    expect(p.p95).toBeLessThanOrEqual(p.p99);
  });

  // ─── Tail Risk ────────────────────────────────────────────────────

  it('GET /risk-scenarios/tail-risk/:agentId returns tail risk analysis', async () => {
    createAgentViaStore(ctx, 'tail-agent-1');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/risk-scenarios/tail-risk/tail-agent-1',
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.agentId).toBe('tail-agent-1');
    expect(result.portfolioValueUsd).toBeGreaterThan(0);
    expect(result.var1Pct).toBeDefined();
    expect(result.var5Pct).toBeDefined();
    expect(result.cvar1Pct).toBeDefined();
    expect(result.cvar5Pct).toBeDefined();
    expect(result.var1Pct).toBeGreaterThanOrEqual(result.var5Pct);
    expect(result.tailScenarios.length).toBeGreaterThan(0);
  });

  it('tail risk returns 404 for unknown agent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/risk-scenarios/tail-risk/nonexistent-agent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Recovery Estimation ──────────────────────────────────────────

  it('GET /risk-scenarios/recovery/:agentId estimates recovery time', async () => {
    createAgentViaStore(ctx, 'recovery-agent-1');
    // Agent has peakEquity 10k but current equity ~ 9k (positions + cash)
    // So there is a drawdown to recover from.

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/risk-scenarios/recovery/recovery-agent-1',
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.agentId).toBe('recovery-agent-1');
    expect(result.currentDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.estimatedRecoveryTicks).toBeGreaterThanOrEqual(0);
    expect(result.recoveryProbability).toBeGreaterThan(0);
    expect(result.recoveryProbability).toBeLessThanOrEqual(1);
    expect(result.recoveryPaths.optimistic).toBeLessThanOrEqual(result.recoveryPaths.expected);
    expect(result.recoveryPaths.expected).toBeLessThanOrEqual(result.recoveryPaths.pessimistic);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it('recovery returns 404 for unknown agent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/risk-scenarios/recovery/nonexistent-agent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('recovery returns 0 ticks when agent is at peak', async () => {
    createAgentViaStore(ctx, 'peak-agent');
    // Adjust so equity exactly matches peak
    const state = ctx.stateStore.snapshot();
    state.agents['peak-agent'].cashUsd = 10_000;
    state.agents['peak-agent'].positions = {};
    state.agents['peak-agent'].peakEquityUsd = 10_000;
    (ctx.stateStore as any).state = state;

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/risk-scenarios/recovery/peak-agent',
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.currentDrawdownPct).toBe(0);
    expect(result.estimatedRecoveryTicks).toBe(0);
    expect(result.recoveryProbability).toBe(1.0);
  });

  // ─── Liquidity Impact ─────────────────────────────────────────────

  it('simulation includes liquidity impact data', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/risk-scenarios/simulate',
      payload: {
        scenarioId: 'terra-luna-collapse',
        portfolio: {
          positions: {
            SOL: { symbol: 'SOL', quantity: 100, avgEntryPriceUsd: 100 },
          },
          cashUsd: 0,
          marketPrices: { SOL: 100 },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.liquidityImpact.drainPct).toBe(0.70);
    expect(result.liquidityImpact.estimatedSlippageBps).toBeGreaterThan(0);
    expect(result.liquidityImpact.affectedAssets.length).toBeGreaterThan(0);
  });
});
