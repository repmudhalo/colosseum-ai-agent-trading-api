import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const testDataDir = path.resolve(process.cwd(), 'data', 'test-autonomous');
const testConfig = {
  ...config,
  paths: {
    ...config.paths,
    dataDir: testDataDir,
    stateFile: path.join(testDataDir, 'state.json'),
    logFile: path.join(testDataDir, 'events.ndjson'),
  },
  autonomous: {
    ...config.autonomous,
    enabled: false, // keep disabled for tests — we test the API toggle
    intervalMs: 60_000,
    maxDrawdownStopPct: 12,
    cooldownMs: 120_000,
    cooldownAfterFailures: 2,
    defaultNotionalUsd: 100,
    minConfidence: 0.15,
  },
};

describe('Autonomous API', () => {
  afterAll(async () => {
    await fs.rm(testDataDir, { recursive: true, force: true });
  });

  it('GET /autonomous/status returns initial state', async () => {
    const { app, autonomousService, worker } = await buildApp(testConfig);
    try {
      const res = await app.inject({ method: 'GET', url: '/autonomous/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('enabled');
      expect(body).toHaveProperty('loopCount');
      expect(body).toHaveProperty('agentStates');
    } finally {
      await autonomousService.stop();
      await worker.stop();
      await app.close();
    }
  });

  it('POST /autonomous/toggle enables and disables the loop', async () => {
    const { app, autonomousService, worker } = await buildApp(testConfig);
    try {
      // Enable
      const enableRes = await app.inject({
        method: 'POST',
        url: '/autonomous/toggle',
        payload: { enabled: true },
      });
      expect(enableRes.statusCode).toBe(200);
      const enableBody = JSON.parse(enableRes.body);
      expect(enableBody.ok).toBe(true);
      expect(enableBody.autonomous.enabled).toBe(true);

      // Disable
      const disableRes = await app.inject({
        method: 'POST',
        url: '/autonomous/toggle',
        payload: { enabled: false },
      });
      expect(disableRes.statusCode).toBe(200);
      const disableBody = JSON.parse(disableRes.body);
      expect(disableBody.autonomous.enabled).toBe(false);
    } finally {
      await autonomousService.stop();
      await worker.stop();
      await app.close();
    }
  });

  it('POST /autonomous/toggle rejects invalid payload', async () => {
    const { app, autonomousService, worker } = await buildApp(testConfig);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/autonomous/toggle',
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await autonomousService.stop();
      await worker.stop();
      await app.close();
    }
  });
});
