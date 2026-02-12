import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-collab',
    stateFile: `/tmp/colosseum-test-collab/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-collab/events-${Date.now()}.ndjson`,
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

describe('CollaborationService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    const cfg = {
      ...testConfig,
      paths: {
        ...testConfig.paths,
        stateFile: `/tmp/colosseum-test-collab/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      },
    };
    ctx = await buildApp(cfg as any);
  });

  it('proposes a collaboration via POST /collaborations', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: {
          type: 'signal-sharing',
          durationMs: 3600000,
          profitSplitPct: 50,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.collaboration.id).toBeDefined();
    expect(body.collaboration.initiatorId).toBe(agent1.id);
    expect(body.collaboration.targetId).toBe(agent2.id);
    expect(body.collaboration.status).toBe('proposed');
    expect(body.collaboration.terms.type).toBe('signal-sharing');
    expect(body.collaboration.terms.profitSplitPct).toBe(50);
  });

  it('accepts a collaboration via POST /collaborations/:id/accept', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'co-trading', durationMs: 7200000, profitSplitPct: 60 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/accept`,
      payload: { agentId: agent2.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().collaboration.status).toBe('active');
  });

  it('rejects a collaboration via POST /collaborations/:id/reject', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'strategy-exchange', durationMs: 3600000, profitSplitPct: 30 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/reject`,
      payload: { agentId: agent2.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().collaboration.status).toBe('rejected');
  });

  it('lists active collaborations via GET /collaborations?agentId=...', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');
    const agent3 = await registerAgent(ctx, 'Agent Gamma');

    await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent3.id,
        targetId: agent1.id,
        terms: { type: 'co-trading', durationMs: 3600000, profitSplitPct: 40 },
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/collaborations?agentId=${agent1.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().collaborations.length).toBe(2);
  });

  it('shares signals within active collaboration', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/accept`,
      payload: { agentId: agent2.id },
    });

    const signalRes = await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/signals`,
      payload: {
        symbol: 'SOL',
        side: 'buy',
        confidence: 0.85,
        priceTarget: 150,
        notes: 'Bullish momentum detected',
      },
    });

    expect(signalRes.statusCode).toBe(201);
    expect(signalRes.json().signal.signal.symbol).toBe('SOL');
    expect(signalRes.json().signal.signal.confidence).toBe(0.85);

    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/collaborations/${collabId}/signals`,
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().signals.length).toBe(1);
    expect(getRes.json().signals[0].signal.symbol).toBe('SOL');
  });

  it('prevents sharing signals in non-active collaborations', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    const signalRes = await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/signals`,
      payload: {
        symbol: 'SOL',
        side: 'buy',
        confidence: 0.85,
      },
    });

    expect(signalRes.statusCode).toBe(400);
  });

  it('terminates a collaboration via DELETE /collaborations/:id', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/accept`,
      payload: { agentId: agent2.id },
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/collaborations/${collabId}?agentId=${agent1.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().collaboration.status).toBe('terminated');
    expect(res.json().collaboration.terminatedBy).toBe(agent1.id);
  });

  it('prevents self-collaboration', async () => {
    const agent = await registerAgent(ctx, 'Solo Agent');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent.id,
        targetId: agent.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cannot collaborate with itself');
  });

  it('prevents non-target from accepting', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const proposeRes = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations',
      payload: {
        initiatorId: agent1.id,
        targetId: agent2.id,
        terms: { type: 'signal-sharing', durationMs: 3600000, profitSplitPct: 50 },
      },
    });
    const collabId = proposeRes.json().collaboration.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/collaborations/${collabId}/accept`,
      payload: { agentId: agent1.id },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for nonexistent collaboration', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/collaborations/nonexistent/accept',
      payload: { agentId: 'some-agent' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns empty list when no agentId provided', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/collaborations',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().collaborations).toEqual([]);
  });
});
