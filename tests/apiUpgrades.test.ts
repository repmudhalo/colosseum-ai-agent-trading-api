import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext, buildApp } from '../src/app.js';
import { AppConfig, config as baseConfig } from '../src/config.js';
import { TradeIntent } from '../src/types.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeTestConfig = (dir: string): AppConfig => ({
  ...baseConfig,
  app: {
    ...baseConfig.app,
    env: 'test',
    port: 0,
  },
  paths: {
    dataDir: dir,
    stateFile: path.join(dir, 'state.json'),
    logFile: path.join(dir, 'events.ndjson'),
  },
  worker: {
    ...baseConfig.worker,
    intervalMs: 40,
    maxBatchSize: 10,
  },
  trading: {
    ...baseConfig.trading,
    defaultMode: 'paper',
    liveEnabled: false,
    liveBroadcastEnabled: false,
    quoteRetryAttempts: 2,
    quoteRetryBaseDelayMs: 1,
  },
  payments: {
    ...baseConfig.payments,
    x402Enabled: false,
  },
});

const testResources: Array<{ ctx: AppContext; dir: string }> = [];

afterEach(async () => {
  while (testResources.length > 0) {
    const { ctx, dir } = testResources.pop()!;
    await ctx.worker.stop();
    await ctx.app.close();
    await ctx.stateStore.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const createContext = async (): Promise<AppContext> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colosseum-api-test-'));
  const ctx = await buildApp(makeTestConfig(dir));
  testResources.push({ ctx, dir });
  return ctx;
};

const registerAgent = async (ctx: AppContext, body: Record<string, unknown>) => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/agents/register',
    payload: body,
  });

  expect(response.statusCode).toBe(201);
  return response.json() as {
    agent: { id: string };
    apiKey: string;
  };
};

const waitForTerminalIntent = async (
  ctx: AppContext,
  intentId: string,
  timeoutMs = 4_000,
): Promise<TradeIntent> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/trade-intents/${intentId}`,
    });

    if (response.statusCode === 200) {
      const intent = response.json() as TradeIntent;
      if (intent.status === 'executed' || intent.status === 'rejected' || intent.status === 'failed') {
        return intent;
      }
    }

    await wait(60);
  }

  throw new Error(`intent ${intentId} did not reach terminal status in ${timeoutMs}ms`);
};

describe('API upgrades', () => {
  it('replays idempotent requests and rejects conflicting payload reuse', async () => {
    const ctx = await createContext();
    const registered = await registerAgent(ctx, { name: 'idempotency-agent' });

    const payload = {
      agentId: registered.agent.id,
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 50,
      requestedMode: 'paper',
    };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': registered.apiKey,
        'x-idempotency-key': 'idem-key-1',
      },
      payload,
    });

    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { replayed: boolean; intent: { id: string } };
    expect(firstBody.replayed).toBe(false);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': registered.apiKey,
        'x-idempotency-key': 'idem-key-1',
      },
      payload,
    });

    expect(replay.statusCode).toBe(200);
    const replayBody = replay.json() as { replayed: boolean; intent: { id: string } };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.intent.id).toBe(firstBody.intent.id);

    const conflicting = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': registered.apiKey,
        'x-idempotency-key': 'idem-key-1',
      },
      payload: {
        ...payload,
        notionalUsd: 75,
      },
    });

    expect(conflicting.statusCode).toBe(409);
    expect((conflicting.json() as { error: { code: string } }).error.code).toBe('idempotency_key_conflict');
  });

  it('returns risk telemetry with cooldown and reject counters (agent + global)', async () => {
    const ctx = await createContext();
    const registered = await registerAgent(ctx, {
      name: 'risk-telemetry-agent',
      riskOverrides: {
        maxOrderNotionalUsd: 100,
        maxPositionSizePct: 1,
        maxGrossExposureUsd: 100_000,
        dailyLossCapUsd: 100_000,
        maxDrawdownPct: 0.95,
        cooldownSeconds: 0,
      },
    });

    for (const px of [101, 102, 103, 104, 105, 106]) {
      const market = await ctx.app.inject({
        method: 'POST',
        url: '/market/prices',
        payload: { symbol: 'SOL', priceUsd: px },
      });
      expect(market.statusCode).toBe(200);
    }

    ctx.worker.start();

    const successfulIntent = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': registered.apiKey,
      },
      payload: {
        agentId: registered.agent.id,
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 50,
        requestedMode: 'paper',
      },
    });

    expect(successfulIntent.statusCode).toBe(202);
    const successfulIntentId = (successfulIntent.json() as { intent: { id: string } }).intent.id;

    const riskyIntent = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': registered.apiKey,
      },
      payload: {
        agentId: registered.agent.id,
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 200,
        requestedMode: 'paper',
      },
    });

    expect(riskyIntent.statusCode).toBe(202);
    const riskyIntentId = (riskyIntent.json() as { intent: { id: string } }).intent.id;

    const filled = await waitForTerminalIntent(ctx, successfulIntentId);
    const rejected = await waitForTerminalIntent(ctx, riskyIntentId);

    expect(filled.status).toBe('executed');
    expect(rejected.status).toBe('rejected');
    expect(rejected.statusReason).toBe('max_order_notional_exceeded');

    const telemetry = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${registered.agent.id}/risk`,
    });

    expect(telemetry.statusCode).toBe(200);
    const body = telemetry.json() as {
      grossExposureUsd: number;
      drawdownPct: number;
      dailyPnlUsd: number;
      cooldown: { active: boolean; remainingSeconds: number };
      rejectCountersByReason: Record<string, number>;
      globalRejectCountersByReason: Record<string, number>;
    };

    expect(typeof body.grossExposureUsd).toBe('number');
    expect(typeof body.drawdownPct).toBe('number');
    expect(typeof body.dailyPnlUsd).toBe('number');
    expect(typeof body.cooldown.active).toBe('boolean');
    expect(typeof body.cooldown.remainingSeconds).toBe('number');
    expect(body.rejectCountersByReason.max_order_notional_exceeded).toBeGreaterThanOrEqual(1);
    expect(body.globalRejectCountersByReason.max_order_notional_exceeded).toBeGreaterThanOrEqual(1);

    const legacyTelemetry = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${registered.agent.id}/risk-telemetry`,
    });

    expect(legacyTelemetry.statusCode).toBe(200);
    const legacyBody = legacyTelemetry.json() as { rejectCountersByReason: Record<string, number> };
    expect(legacyBody.rejectCountersByReason.max_order_notional_exceeded).toBeGreaterThanOrEqual(1);
  });
});
