import { afterEach, describe, expect, it } from 'vitest';
import { AppContext, buildApp } from '../src/app.js';
import { buildTestConfig, createTempDir } from './helpers.js';

describe('experiment dashboard routes', () => {
  let ctx: AppContext | undefined;

  afterEach(async () => {
    if (ctx) {
      await ctx.worker.stop();
      await ctx.app.close();
      await ctx.stateStore.flush();
      ctx = undefined;
    }
  });

  it('serves judge-facing dashboard html on /experiment', async () => {
    const tmpDir = await createTempDir();
    ctx = await buildApp(buildTestConfig(tmpDir));

    const res = await ctx.app.inject({ method: 'GET', url: '/experiment' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Timmy Agent Trading API');
    expect(res.body).toContain('/receipts/verify/');
  });

  it('returns registered agents list for dashboard selector', async () => {
    const tmpDir = await createTempDir();
    ctx = await buildApp(buildTestConfig(tmpDir));

    const register = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'dashboard-agent' },
    });

    expect(register.statusCode).toBe(201);

    const res = await ctx.app.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { agents: Array<{ name: string }> };
    expect(body.agents.length).toBe(1);
    expect(body.agents[0]?.name).toBe('dashboard-agent');
  });
});
