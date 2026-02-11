import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { ExecutionMode, Side, TradeIntent } from '../types.js';
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

export class TradeIntentService {
  constructor(private readonly store: StateStore) {}

  async create(input: CreateTradeIntentInput): Promise<TradeIntent> {
    const now = isoNow();
    const intent: TradeIntent = {
      id: uuid(),
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      ...input,
      symbol: input.symbol.toUpperCase(),
    };

    await this.store.transaction((state) => {
      state.tradeIntents[intent.id] = intent;
      state.metrics.intentsReceived += 1;
      return undefined;
    });

    return intent;
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
