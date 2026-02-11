import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppContext } from '../src/app.js';
import { buildTestConfig, createTempDir } from './helpers.js';

describe('POST /trade-intents idempotency', () => {
  let ctx: AppContext | undefined;

  afterEach(async () => {
    if (ctx) {
      await ctx.worker.stop();
      await ctx.app.close();
      await ctx.stateStore.flush();
      ctx = undefined;
    }
  });

  it('replays the same intent for the same agent and x-idempotency-key', async () => {
    const tmpDir = await createTempDir();
    ctx = await buildApp(buildTestConfig(tmpDir));

    const register = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'idem-agent' },
    });

    expect(register.statusCode).toBe(201);
    const body = register.json() as { agent: { id: string }; apiKey: string };

    const payload = {
      agentId: body.agent.id,
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 100,
      requestedMode: 'paper',
    };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': body.apiKey,
        'x-idempotency-key': 'same-key-1',
      },
      payload,
    });

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/trade-intents',
      headers: {
        'x-agent-api-key': body.apiKey,
        'x-idempotency-key': 'same-key-1',
      },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);

    const firstBody = first.json() as { replayed: boolean; intent: { id: string } };
    const secondBody = second.json() as { replayed: boolean; intent: { id: string } };

    expect(firstBody.replayed).toBe(false);
    expect(secondBody.replayed).toBe(true);
    expect(firstBody.intent.id).toBe(secondBody.intent.id);

    const state = ctx.stateStore.snapshot();
    expect(Object.keys(state.tradeIntents)).toHaveLength(1);
    expect(state.metrics.intentsReceived).toBe(1);
  });
});
