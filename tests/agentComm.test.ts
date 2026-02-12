import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp, AppContext } from '../src/app.js';
import { eventBus } from '../src/infra/eventBus.js';

const testConfig = {
  app: { name: 'test', env: 'test', port: 0 },
  paths: {
    dataDir: '/tmp/colosseum-test-comm',
    stateFile: `/tmp/colosseum-test-comm/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    logFile: `/tmp/colosseum-test-comm/events-${Date.now()}.ndjson`,
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

function freshConfig() {
  return {
    ...testConfig,
    paths: {
      ...testConfig.paths,
      stateFile: `/tmp/colosseum-test-comm/state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    },
  };
}

describe('AgentCommService', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    eventBus.clear();
    ctx = await buildApp(freshConfig() as any);
  });

  // ── 1. Send a direct message ──────────────────────────────────────

  it('sends a direct message via POST /comm/send', async () => {
    const sender = await registerAgent(ctx, 'Sender-A');
    const receiver = await registerAgent(ctx, 'Receiver-B');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: sender.id,
        to: receiver.id,
        type: 'signal',
        subject: 'Buy SOL',
        body: 'Strong momentum detected on SOL',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.message.from).toBe(sender.id);
    expect(body.message.to).toBe(receiver.id);
    expect(body.message.type).toBe('signal');
    expect(body.message.deliveryStatus).toBe('sent');
    expect(body.message.encrypted).toBe(false);
  });

  // ── 2. Retrieve inbox messages ────────────────────────────────────

  it('retrieves inbox messages via GET /comm/inbox/:agentId', async () => {
    const sender = await registerAgent(ctx, 'Sender-X');
    const receiver = await registerAgent(ctx, 'Receiver-Y');

    await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: sender.id,
        to: receiver.id,
        type: 'chat',
        subject: 'Hello',
        body: 'How is your strategy performing?',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/comm/inbox/${receiver.id}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].subject).toBe('Hello');
  });

  // ── 3. Create a channel ───────────────────────────────────────────

  it('creates a broadcast channel via POST /comm/channels', async () => {
    const agent = await registerAgent(ctx, 'ChannelCreator');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: {
        name: 'SOL-Signals',
        description: 'SOL trading signals broadcast',
        type: 'broadcast',
        creatorId: agent.id,
        allowedMessageTypes: ['signal', 'alert'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel.name).toBe('SOL-Signals');
    expect(body.channel.type).toBe('broadcast');
    expect(body.channel.subscriberIds).toContain(agent.id);
    expect(body.channel.allowedMessageTypes).toEqual(['signal', 'alert']);
  });

  // ── 4. List channels ──────────────────────────────────────────────

  it('lists channels via GET /comm/channels', async () => {
    const agent = await registerAgent(ctx, 'Lister');

    await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: {
        name: 'Market-Updates',
        type: 'group',
        creatorId: agent.id,
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/comm/channels',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channels.length).toBeGreaterThanOrEqual(1);
    expect(body.channels.some((ch: any) => ch.name === 'Market-Updates')).toBe(true);
  });

  // ── 5. Subscribe to a channel ─────────────────────────────────────

  it('subscribes to a channel via POST /comm/channels/:id/subscribe', async () => {
    const creator = await registerAgent(ctx, 'Creator');
    const subscriber = await registerAgent(ctx, 'Sub');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Alerts-Channel', type: 'broadcast', creatorId: creator.id },
    });
    const channelId = chRes.json().channel.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/comm/channels/${channelId}/subscribe`,
      payload: { agentId: subscriber.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channel.subscriberIds).toContain(subscriber.id);
  });

  // ── 6. Get channel messages ───────────────────────────────────────

  it('retrieves channel messages via GET /comm/channels/:id/messages', async () => {
    const creator = await registerAgent(ctx, 'BroadcastSender');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Broadcast-Test', type: 'broadcast', creatorId: creator.id },
    });
    const channelId = chRes.json().channel.id;

    await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: creator.id,
        channelId,
        type: 'market-update',
        subject: 'SOL pump',
        body: 'SOL is pumping hard',
      },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/comm/channels/${channelId}/messages`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].subject).toBe('SOL pump');
  });

  // ── 7. Encrypted messaging ────────────────────────────────────────

  it('sends encrypted messages with AES-256-GCM', async () => {
    const sender = await registerAgent(ctx, 'EncSender');
    const receiver = await registerAgent(ctx, 'EncReceiver');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: sender.id,
        to: receiver.id,
        type: 'trade-proposal',
        subject: 'Secret Trade',
        body: 'Buy 1000 SOL at market',
        encrypt: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.message.encrypted).toBe(true);
    expect(body.message.body).toBe('[encrypted]');
    expect(body.message.encryptedBody).toBeTruthy();
    expect(body.message.iv).toBeTruthy();
    expect(body.message.authTag).toBeTruthy();
  });

  // ── 8. Message threading ──────────────────────────────────────────

  it('supports message threading with parent references', async () => {
    const a = await registerAgent(ctx, 'ThreadA');
    const b = await registerAgent(ctx, 'ThreadB');

    const msg1Res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: a.id,
        to: b.id,
        type: 'chat',
        subject: 'Strategy Discussion',
        body: 'What do you think about DCA on SOL?',
      },
    });
    const msg1 = msg1Res.json().message;

    const msg2Res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: b.id,
        to: a.id,
        type: 'chat',
        subject: 'Re: Strategy Discussion',
        body: 'Great idea, I have been doing DCA weekly.',
        parentMessageId: msg1.id,
      },
    });
    const msg2 = msg2Res.json().message;

    expect(msg2.parentMessageId).toBe(msg1.id);
    expect(msg2.threadId).toBe(msg1.id);
  });

  // ── 9. Message acknowledgment ─────────────────────────────────────

  it('acknowledges message delivery via POST /comm/messages/:id/ack', async () => {
    const sender = await registerAgent(ctx, 'AckSender');
    const receiver = await registerAgent(ctx, 'AckReceiver');

    const sendRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: sender.id,
        to: receiver.id,
        type: 'alert',
        subject: 'Risk Alert',
        body: 'Drawdown threshold exceeded',
      },
    });
    const messageId = sendRes.json().message.id;

    const ackRes = await ctx.app.inject({
      method: 'POST',
      url: `/comm/messages/${messageId}/ack`,
      payload: { agentId: receiver.id },
    });

    expect(ackRes.statusCode).toBe(200);
    const body = ackRes.json();
    expect(body.message.deliveryStatus).toBe('read');
    expect(body.message.acknowledgedAt).toBeTruthy();
  });

  // ── 10. Reject invalid message type ───────────────────────────────

  it('rejects invalid message type', async () => {
    const sender = await registerAgent(ctx, 'BadTypeSender');
    const receiver = await registerAgent(ctx, 'BadTypeReceiver');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: sender.id,
        to: receiver.id,
        type: 'invalid-type',
        subject: 'Test',
        body: 'Test body',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── 11. Non-subscriber cannot send to channel ─────────────────────

  it('prevents non-subscriber from sending to a channel', async () => {
    const creator = await registerAgent(ctx, 'ChCreator');
    const outsider = await registerAgent(ctx, 'Outsider');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Private-Channel', type: 'group', creatorId: creator.id },
    });
    const channelId = chRes.json().channel.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: outsider.id,
        channelId,
        type: 'chat',
        subject: 'Intruder',
        body: 'Trying to sneak in',
      },
    });

    expect(res.statusCode).toBe(403);
  });

  // ── 12. Duplicate channel name rejected ───────────────────────────

  it('rejects duplicate channel names', async () => {
    const agent = await registerAgent(ctx, 'DupCreator');

    await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Unique-Ch', type: 'broadcast', creatorId: agent.id },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Unique-Ch', type: 'broadcast', creatorId: agent.id },
    });

    expect(res.statusCode).toBe(409);
  });

  // ── 13. Channel type filter rejects wrong message types ───────────

  it('rejects disallowed message types in channel', async () => {
    const agent = await registerAgent(ctx, 'TypeFilter');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: {
        name: 'Signals-Only',
        type: 'broadcast',
        creatorId: agent.id,
        allowedMessageTypes: ['signal'],
      },
    });
    const channelId = chRes.json().channel.id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: agent.id,
        channelId,
        type: 'chat',
        subject: 'Wrong type',
        body: 'This should be rejected',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── 14. Already subscribed agent gets 409 ─────────────────────────

  it('returns 409 when agent is already subscribed to channel', async () => {
    const creator = await registerAgent(ctx, 'DoubleSubCreator');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'Double-Sub', type: 'broadcast', creatorId: creator.id },
    });
    const channelId = chRes.json().channel.id;

    // Creator is auto-subscribed, trying to subscribe again
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/comm/channels/${channelId}/subscribe`,
      payload: { agentId: creator.id },
    });

    expect(res.statusCode).toBe(409);
  });

  // ── 15. Broadcast reaches all channel subscribers ─────────────────

  it('broadcast message appears in subscriber inboxes', async () => {
    const creator = await registerAgent(ctx, 'Broadcaster');
    const sub1 = await registerAgent(ctx, 'SubOne');
    const sub2 = await registerAgent(ctx, 'SubTwo');

    const chRes = await ctx.app.inject({
      method: 'POST',
      url: '/comm/channels',
      payload: { name: 'BroadCh', type: 'broadcast', creatorId: creator.id },
    });
    const channelId = chRes.json().channel.id;

    // Subscribe both agents
    await ctx.app.inject({
      method: 'POST',
      url: `/comm/channels/${channelId}/subscribe`,
      payload: { agentId: sub1.id },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/comm/channels/${channelId}/subscribe`,
      payload: { agentId: sub2.id },
    });

    // Broadcast
    await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: creator.id,
        channelId,
        type: 'alert',
        subject: 'Market crash',
        body: 'SOL down 20%',
      },
    });

    // Both subscribers should see it in their inbox
    const inbox1 = await ctx.app.inject({ method: 'GET', url: `/comm/inbox/${sub1.id}` });
    const inbox2 = await ctx.app.inject({ method: 'GET', url: `/comm/inbox/${sub2.id}` });

    expect(inbox1.json().messages.length).toBe(1);
    expect(inbox2.json().messages.length).toBe(1);
    expect(inbox1.json().messages[0].subject).toBe('Market crash');
  });

  // ── 16. Sender not found returns 404 ──────────────────────────────

  it('returns 404 for unknown sender agent', async () => {
    const receiver = await registerAgent(ctx, 'ValidReceiver');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/comm/send',
      payload: {
        from: 'nonexistent-agent',
        to: receiver.id,
        type: 'chat',
        subject: 'Ghost',
        body: 'Boo',
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
