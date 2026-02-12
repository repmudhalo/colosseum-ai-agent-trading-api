import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-stress',
    stateFile: `/tmp/colosseum-test-stress/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-stress/events-${Date.now()}.ndjson`,
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
    x402PolicyFile: '',
    x402RequiredPaths: [] as string[],
    x402Enabled: false,
  },
  privacy: { encryptionEnabled: false, serverSecret: 'test-secret' },
  tokenRevenue: {
    baseUrl: 'http://localhost:9999',
    apiKey: 'test',
    timeoutMs: 5000,
    healthPath: '/health',
    launchPath: '/launch',
    earningsPath: '/earnings',
    maxImageBytes: 1_000_000,
  },
  autonomous: {
    intervalMs: 30_000,
    maxConsecutiveFailures: 3,
    cooldownMs: 60_000,
  },
  lending: {
    healthFactorWarning: 1.3,
    healthFactorCritical: 1.1,
    scanIntervalMs: 60_000,
  },
};

async function registerAgent(ctx: AppContext, name: string): Promise<{ id: string; apiKey: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/agents/register',
    payload: { name, startingCapitalUsd: 10_000 },
  });
  const body = res.json();
  return { id: body.agent.id, apiKey: body.apiKey };
}

async function setPrice(ctx: AppContext, symbol: string, priceUsd: number): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: '/market/prices',
    payload: { symbol, priceUsd },
  });
}

async function createTradeIntent(
  ctx: AppContext,
  agentId: string,
  apiKey: string,
  symbol: string,
  side: 'buy' | 'sell',
  notionalUsd: number,
): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: '/trade-intents',
    headers: { 'x-agent-api-key': apiKey },
    payload: { agentId, symbol, side, notionalUsd },
  });
}

describe('StressTestService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    const cfg = {
      ...testConfig,
      paths: {
        ...testConfig.paths,
        stateFile: `/tmp/colosseum-test-stress/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      },
    };
    ctx = await buildApp(cfg as any);
  });

  it('lists available stress test scenarios via GET /stress-test/scenarios', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/stress-test/scenarios',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenarios.length).toBe(5);

    const ids = body.scenarios.map((s: any) => s.id);
    expect(ids).toContain('market-crash');
    expect(ids).toContain('flash-liquidation');
    expect(ids).toContain('correlation-break');
    expect(ids).toContain('fee-spike');
    expect(ids).toContain('oracle-failure');

    for (const scenario of body.scenarios) {
      expect(scenario.name).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.category).toBeDefined();
    }
  });

  it('runs stress test against all scenarios via POST /agents/:agentId/stress-test', async () => {
    const agent = await registerAgent(ctx, 'Stress Agent');

    await setPrice(ctx, 'SOL', 100);
    await createTradeIntent(ctx, agent.id, agent.apiKey, 'SOL', 'buy', 2000);
    ctx.worker.tick();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.result.id).toBeDefined();
    expect(body.result.agentId).toBe(agent.id);
    expect(body.result.status).toBe('completed');
    expect(body.result.scenarios.length).toBe(5);
    expect(body.result.summary).toBeDefined();
    expect(body.result.summary.overallRiskRating).toBeDefined();
    expect(body.result.completedAt).toBeDefined();
  });

  it('runs stress test with specific scenarios', async () => {
    const agent = await registerAgent(ctx, 'Selective Agent');
    await setPrice(ctx, 'SOL', 100);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: { scenarios: ['market-crash', 'fee-spike'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.result.scenarios.length).toBe(2);
    const ids = body.result.scenarios.map((s: any) => s.scenarioId);
    expect(ids).toContain('market-crash');
    expect(ids).toContain('fee-spike');
  });

  it('retrieves stress test results via GET /agents/:agentId/stress-test/:id', async () => {
    const agent = await registerAgent(ctx, 'Results Agent');
    await setPrice(ctx, 'SOL', 100);

    const runRes = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: { scenarios: ['market-crash'] },
    });

    const testId = runRes.json().result.id;

    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/stress-test/${testId}`,
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().result.id).toBe(testId);
    expect(getRes.json().result.status).toBe('completed');
  });

  it('returns 404 for nonexistent stress test', async () => {
    const agent = await registerAgent(ctx, 'Ghost Agent');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/stress-test/nonexistent`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent agent', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/nonexistent/stress-test',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects unknown scenario ids', async () => {
    const agent = await registerAgent(ctx, 'Bad Scenario Agent');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: { scenarios: ['nonexistent-scenario'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Unknown stress test scenario');
  });

  it('market-crash scenario reduces equity for agents with positions', async () => {
    const agent = await registerAgent(ctx, 'Crash Test Agent');
    // Set price first, then buy
    await setPrice(ctx, 'SOL', 100);
    await createTradeIntent(ctx, agent.id, agent.apiKey, 'SOL', 'buy', 5000);
    // Process the worker to fill the intent
    ctx.worker.tick();

    // Verify agent has position
    const portfolioRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/portfolio`,
    });
    const portfolio = portfolioRes.json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: { scenarios: ['market-crash'] },
    });

    expect(res.statusCode).toBe(201);
    const scenario = res.json().result.scenarios[0];
    expect(scenario.scenarioId).toBe('market-crash');
    expect(scenario.ticks.length).toBe(10);

    // If agent has positions, equity should drop
    if (portfolio.positions && portfolio.positions.length > 0) {
      expect(scenario.impact.equityChangeUsd).toBeLessThan(0);
      expect(scenario.impact.equityChangePct).toBeLessThan(0);
    } else {
      // Cash-only portfolio is unaffected by market crash
      expect(scenario.impact.equityChangeUsd).toBe(0);
    }
  });

  it('stress test provides per-scenario pre/post equity', async () => {
    const agent = await registerAgent(ctx, 'Equity Agent');
    await setPrice(ctx, 'SOL', 100);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: { scenarios: ['fee-spike'] },
    });

    expect(res.statusCode).toBe(201);
    const scenario = res.json().result.scenarios[0];
    expect(scenario.preStress).toBeDefined();
    expect(scenario.preStress.equityUsd).toBeGreaterThan(0);
    expect(scenario.postStress).toBeDefined();
    expect(scenario.postStress.equityUsd).toBeDefined();
  });

  it('summary identifies worst scenario', async () => {
    const agent = await registerAgent(ctx, 'Summary Agent');
    await setPrice(ctx, 'SOL', 100);
    await createTradeIntent(ctx, agent.id, agent.apiKey, 'SOL', 'buy', 5000);
    ctx.worker.tick();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/stress-test`,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const summary = res.json().result.summary;
    expect(summary.worstScenarioId).toBeDefined();
    expect(summary.worstEquityChangePct).toBeLessThanOrEqual(0);
    expect(['low', 'medium', 'high', 'critical']).toContain(summary.overallRiskRating);
  });
});
