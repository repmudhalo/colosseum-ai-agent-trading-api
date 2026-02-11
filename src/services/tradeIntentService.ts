import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { ExecutionMode, Side, TradeIntent } from '../types.js';
import { hashObject } from '../utils/hash.js';
import { isoNow } from '../utils/time.js';

export interface CreateTradeIntentInput {
  agentId: string;
  symbol: string;
  side: Side;
  quantity?: number;
  notionalUsd?: number;
  requestedMode?: ExecutionMode;
  meta?: Record<string, unknown>;
}

export interface CreateTradeIntentOptions {
  idempotencyKey?: string;
}

export interface CreateTradeIntentResult {
  intent: TradeIntent;
  replayed: boolean;
}

const idempotencyKeyFor = (agentId: string, key: string): string => `${agentId}:${key}`;

export class TradeIntentService {
  constructor(private readonly store: StateStore) {}

  async create(
    input: CreateTradeIntentInput,
    options: CreateTradeIntentOptions = {},
  ): Promise<CreateTradeIntentResult> {
    const now = isoNow();

    const normalizedIntent = {
      ...input,
      symbol: input.symbol.toUpperCase(),
    };

    const requestHash = hashObject({
      agentId: normalizedIntent.agentId,
      symbol: normalizedIntent.symbol,
      side: normalizedIntent.side,
      quantity: normalizedIntent.quantity,
      notionalUsd: normalizedIntent.notionalUsd,
      requestedMode: normalizedIntent.requestedMode,
      meta: normalizedIntent.meta,
    });

    return this.store.transaction((state) => {
      const normalizedKey = options.idempotencyKey?.trim();

      if (normalizedKey) {
        const lookup = idempotencyKeyFor(normalizedIntent.agentId, normalizedKey);
        const existing = state.idempotencyRecords[lookup];

        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new DomainError(
              ErrorCode.IdempotencyKeyConflict,
              409,
              'Idempotency key was already used with a different payload.',
              {
                key: normalizedKey,
                existingIntentId: existing.intentId,
              },
            );
          }

          const existingIntent = state.tradeIntents[existing.intentId];
          if (!existingIntent) {
            throw new DomainError(
              ErrorCode.InternalError,
              500,
              `Idempotency record points to missing intent '${existing.intentId}'`,
            );
          }

          state.metrics.idempotencyReplays += 1;
          return {
            intent: { ...existingIntent },
            replayed: true,
          };
        }

        const intent: TradeIntent = {
          id: uuid(),
          createdAt: now,
          updatedAt: now,
          status: 'pending',
          ...normalizedIntent,
          idempotencyKey: normalizedKey,
          requestHash,
        };

        state.tradeIntents[intent.id] = intent;
        state.idempotencyRecords[lookup] = {
          key: normalizedKey,
          agentId: normalizedIntent.agentId,
          requestHash,
          intentId: intent.id,
          createdAt: now,
        };
        state.metrics.intentsReceived += 1;

        return {
          intent: { ...intent },
          replayed: false,
        };
      }

      const intent: TradeIntent = {
        id: uuid(),
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        ...normalizedIntent,
      };

      state.tradeIntents[intent.id] = intent;
      state.metrics.intentsReceived += 1;

      return {
        intent: { ...intent },
        replayed: false,
      };
    });
  }

  getById(intentId: string): TradeIntent | undefined {
    return this.store.snapshot().tradeIntents[intentId];
  }

  listPending(limit = 20): TradeIntent[] {
    const intents = Object.values(this.store.snapshot().tradeIntents)
      .filter((intent) => intent.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return intents.slice(0, limit);
  }
}
