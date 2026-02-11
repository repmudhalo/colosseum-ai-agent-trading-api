import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/errors/taxonomy.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { TradeIntentService } from '../src/services/tradeIntentService.js';

const withStore = async <T>(fn: (service: TradeIntentService) => Promise<T>): Promise<T> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-idempotency-'));
  const store = new StateStore(path.join(dir, 'state.json'));
  await store.init();

  try {
    return await fn(new TradeIntentService(store));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

describe('TradeIntentService idempotency', () => {
  it('replays same intent when key + payload match', async () => {
    await withStore(async (service) => {
      const first = await service.create({
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 250,
      }, {
        idempotencyKey: 'same-key',
      });

      const second = await service.create({
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 250,
      }, {
        idempotencyKey: 'same-key',
      });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.intent.id).toBe(first.intent.id);
    });
  });

  it('rejects idempotency key reuse with different payload', async () => {
    await withStore(async (service) => {
      await service.create({
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 250,
      }, {
        idempotencyKey: 'conflict-key',
      });

      await expect(service.create({
        agentId: 'agent-1',
        symbol: 'SOL',
        side: 'buy',
        notionalUsd: 500,
      }, {
        idempotencyKey: 'conflict-key',
      })).rejects.toMatchObject({
        code: ErrorCode.IdempotencyKeyConflict,
        statusCode: 409,
      });
    });
  });
});
