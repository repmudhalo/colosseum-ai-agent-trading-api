import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-social',
    stateFile: `/tmp/colosseum-test-social/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-social/events-${Date.now()}.ndjson`,
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

describe('SocialTradingService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    const cfg = {
      ...testConfig,
      paths: {
        ...testConfig.paths,
        stateFile: `/tmp/colosseum-test-social/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      },
    };
    ctx = await buildApp(cfg as any);
  });

  it('follows an agent via POST /agents/:agentId/social/follow/:targetId', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.relation.followerId).toBe(agent1.id);
    expect(body.relation.targetId).toBe(agent2.id);
    expect(body.relation.id).toBeDefined();
    expect(body.relation.createdAt).toBeDefined();
  });

  it('unfollows an agent via DELETE', async () => {
    const agent1 = await registerAgent(ctx, 'Agent Alpha');
    const agent2 = await registerAgent(ctx, 'Agent Beta');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().unfollowed).toBe(true);
  });

  it('lists followers of an agent', async () => {
    const leader = await registerAgent(ctx, 'Leader');
    const follower1 = await registerAgent(ctx, 'Follower 1');
    const follower2 = await registerAgent(ctx, 'Follower 2');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower1.id}/social/follow/${leader.id}`,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower2.id}/social/follow/${leader.id}`,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${leader.id}/social/followers`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.followers.length).toBe(2);
    expect(body.followers.map((f: any) => f.followerId).sort()).toEqual(
      [follower1.id, follower2.id].sort(),
    );
  });

  it('lists who an agent is following', async () => {
    const follower = await registerAgent(ctx, 'Follower');
    const target1 = await registerAgent(ctx, 'Target 1');
    const target2 = await registerAgent(ctx, 'Target 2');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower.id}/social/follow/${target1.id}`,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower.id}/social/follow/${target2.id}`,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${follower.id}/social/following`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.following.length).toBe(2);
  });

  it('returns empty followers/following for agents with no relations', async () => {
    const agent = await registerAgent(ctx, 'Lonely Agent');

    const followersRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/social/followers`,
    });
    expect(followersRes.json().followers).toEqual([]);

    const followingRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/social/following`,
    });
    expect(followingRes.json().following).toEqual([]);
  });

  it('prevents self-follow', async () => {
    const agent = await registerAgent(ctx, 'Narcissist');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/social/follow/${agent.id}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cannot follow itself');
  });

  it('prevents duplicate follows', async () => {
    const agent1 = await registerAgent(ctx, 'Agent 1');
    const agent2 = await registerAgent(ctx, 'Agent 2');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('already following');
  });

  it('returns 404 when following nonexistent agent', async () => {
    const agent = await registerAgent(ctx, 'Real Agent');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent.id}/social/follow/ghost-agent`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when unfollowing a non-existent relation', async () => {
    const agent1 = await registerAgent(ctx, 'Agent 1');
    const agent2 = await registerAgent(ctx, 'Agent 2');

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns an empty feed when not following anyone', async () => {
    const agent = await registerAgent(ctx, 'Solo Agent');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agent.id}/social/feed`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feed).toEqual([]);
  });

  it('gets feed from followed agents', async () => {
    const follower = await registerAgent(ctx, 'Follower');
    const leader = await registerAgent(ctx, 'Leader');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower.id}/social/follow/${leader.id}`,
    });

    // Simulate some activity for the leader by emitting events
    eventBus.emit('intent.created', {
      intentId: 'test-intent-1',
      agentId: leader.id,
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 500,
    });

    eventBus.emit('intent.executed', {
      intentId: 'test-intent-1',
      agentId: leader.id,
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 500,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${follower.id}/social/feed`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.feed.length).toBe(2);
    expect(body.feed[0].agentId).toBe(leader.id);
    expect(body.feed[0].eventType).toBeDefined();
    expect(body.feed[0].data).toBeDefined();
  });

  it('feed respects limit parameter', async () => {
    const follower = await registerAgent(ctx, 'Follower');
    const leader = await registerAgent(ctx, 'Leader');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower.id}/social/follow/${leader.id}`,
    });

    // Generate multiple events
    for (let i = 0; i < 10; i++) {
      eventBus.emit('intent.created', {
        intentId: `intent-${i}`,
        agentId: leader.id,
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 100 * i,
      });
    }

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${follower.id}/social/feed?limit=3`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().feed.length).toBe(3);
  });

  it('emits social events on follow/unfollow', async () => {
    const events: unknown[] = [];
    eventBus.on('social.followed', (_e, d) => events.push({ type: 'followed', data: d }));
    eventBus.on('social.unfollowed', (_e, d) => events.push({ type: 'unfollowed', data: d }));

    const agent1 = await registerAgent(ctx, 'A1');
    const agent2 = await registerAgent(ctx, 'A2');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/${agent1.id}/social/follow/${agent2.id}`,
    });

    expect(events.length).toBe(2);
    expect((events[0] as any).type).toBe('followed');
    expect((events[1] as any).type).toBe('unfollowed');
  });

  it('followers list updates after unfollow', async () => {
    const leader = await registerAgent(ctx, 'Leader');
    const follower = await registerAgent(ctx, 'Follower');

    await ctx.app.inject({
      method: 'POST',
      url: `/agents/${follower.id}/social/follow/${leader.id}`,
    });

    // Verify follower is listed
    let followersRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${leader.id}/social/followers`,
    });
    expect(followersRes.json().followers.length).toBe(1);

    // Unfollow
    await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/${follower.id}/social/follow/${leader.id}`,
    });

    // Verify follower is removed
    followersRes = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${leader.id}/social/followers`,
    });
    expect(followersRes.json().followers.length).toBe(0);
  });
});
