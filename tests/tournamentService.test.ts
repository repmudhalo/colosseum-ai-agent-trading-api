import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-tournament',
    stateFile: `/tmp/colosseum-test-tournament/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-tournament/events-${Date.now()}.ndjson`,
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

function trendingUp(start: number, ticks: number, stepPct = 0.01): number[] {
  const prices: number[] = [start];
  for (let i = 1; i < ticks; i++) {
    prices.push(prices[i - 1] * (1 + stepPct));
  }
  return prices;
}

describe('TournamentService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    const cfg = {
      ...testConfig,
      paths: {
        ...testConfig.paths,
        stateFile: `/tmp/colosseum-test-tournament/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      },
    };
    ctx = await buildApp(cfg as any);
  });

  it('creates a tournament via POST /tournaments', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Alpha Tournament',
        strategyIds: ['momentum-v1', 'mean-reversion-v1'],
        priceHistory: trendingUp(100, 30),
        startingCapitalUsd: 10_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.tournament.id).toBeDefined();
    expect(body.tournament.name).toBe('Alpha Tournament');
    expect(body.tournament.status).toBe('pending');
    expect(body.tournament.strategyIds).toEqual(['momentum-v1', 'mean-reversion-v1']);
    expect(body.tournament.entries).toEqual([]);
    expect(body.tournament.winner).toBeNull();
  });

  it('runs a tournament and produces ranked results', async () => {
    // Create
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Ranked Test',
        strategyIds: ['momentum-v1', 'mean-reversion-v1', 'dca-v1'],
        priceHistory: trendingUp(100, 50),
        startingCapitalUsd: 10_000,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { tournament } = createRes.json();

    // Run
    const runRes = await ctx.app.inject({
      method: 'POST',
      url: `/tournaments/${tournament.id}/run`,
    });

    expect(runRes.statusCode).toBe(200);
    const result = runRes.json();
    expect(result.tournament.status).toBe('completed');
    expect(result.tournament.entries.length).toBe(3);
    expect(result.tournament.completedAt).toBeDefined();
    expect(result.tournament.winner).toBeDefined();
    expect(result.tournament.winner.rank).toBe(1);

    // Verify ranks are sequential
    const ranks = result.tournament.entries.map((e: any) => e.rank);
    expect(ranks).toEqual([1, 2, 3]);

    // Verify each entry has required metrics
    for (const entry of result.tournament.entries) {
      expect(entry.strategyId).toBeDefined();
      expect(typeof entry.totalReturnPct).toBe('number');
      expect(typeof entry.sharpeRatio).toBe('number');
      expect(typeof entry.maxDrawdownPct).toBe('number');
      expect(typeof entry.winRate).toBe('number');
      expect(typeof entry.tradeCount).toBe('number');
      expect(typeof entry.rank).toBe('number');
    }
  });

  it('gets tournament by ID', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Get Test',
        strategyIds: ['momentum-v1', 'dca-v1'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    const { tournament } = createRes.json();

    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/tournaments/${tournament.id}`,
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().tournament.id).toBe(tournament.id);
    expect(getRes.json().tournament.name).toBe('Get Test');
  });

  it('returns 404 for unknown tournament', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/tournaments/nonexistent-id',
    });

    expect(res.statusCode).toBe(404);
  });

  it('lists all tournaments', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'T1',
        strategyIds: ['momentum-v1', 'dca-v1'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'T2',
        strategyIds: ['momentum-v1', 'mean-reversion-v1'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: '/tournaments',
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().tournaments.length).toBe(2);
  });

  it('rejects creating a tournament with fewer than 2 strategies', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Bad Tournament',
        strategyIds: ['momentum-v1'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects creating a tournament with fewer than 2 price points', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Bad Tournament',
        strategyIds: ['momentum-v1', 'dca-v1'],
        priceHistory: [100],
        startingCapitalUsd: 5000,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects running a tournament that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments/ghost/run',
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects re-running a completed tournament', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Once Only',
        strategyIds: ['momentum-v1', 'dca-v1'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    const { tournament } = createRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: `/tournaments/${tournament.id}/run`,
    });

    const rerunRes = await ctx.app.inject({
      method: 'POST',
      url: `/tournaments/${tournament.id}/run`,
    });

    expect(rerunRes.statusCode).toBe(400);
  });

  it('emits tournament events', async () => {
    const events: unknown[] = [];
    eventBus.on('tournament.created', (_e, d) => events.push({ type: 'created', data: d }));
    eventBus.on('tournament.completed', (_e, d) => events.push({ type: 'completed', data: d }));

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Event Test',
        strategyIds: ['momentum-v1', 'dca-v1'],
        priceHistory: trendingUp(100, 30),
        startingCapitalUsd: 5000,
      },
    });

    const { tournament } = createRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: `/tournaments/${tournament.id}/run`,
    });

    expect(events.length).toBe(2);
    expect((events[0] as any).type).toBe('created');
    expect((events[1] as any).type).toBe('completed');
    expect((events[1] as any).data.winner).toBeDefined();
  });

  it('handles unknown strategyId gracefully during run', async () => {
    // We need to bypass zod and create directly in state since zod won't catch unknown strategy IDs
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Bad Strategy',
        strategyIds: ['momentum-v1', 'nonexistent-strategy'],
        priceHistory: trendingUp(100, 20),
        startingCapitalUsd: 5000,
      },
    });

    const { tournament } = createRes.json();

    const runRes = await ctx.app.inject({
      method: 'POST',
      url: `/tournaments/${tournament.id}/run`,
    });

    // Should fail because 'nonexistent-strategy' is unknown
    expect(runRes.statusCode).toBe(400);
  });

  it('uses custom symbol when provided', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tournaments',
      payload: {
        name: 'Custom Symbol',
        strategyIds: ['momentum-v1', 'dca-v1'],
        symbol: 'BONK',
        priceHistory: trendingUp(0.00002, 30, 0.005),
        startingCapitalUsd: 1000,
      },
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().tournament.symbol).toBe('BONK');
  });
});
