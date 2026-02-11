/**
 * Trade Journal / Activity Log Service.
 *
 * Auto-logs every significant agent action: trades, strategy changes,
 * risk events, squad joins, marketplace subscriptions.
 * Hooks into eventBus to capture events automatically.
 */

import { v4 as uuid } from 'uuid';
import { eventBus, EventType } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export type JournalAction =
  | 'trade'
  | 'strategy_change'
  | 'risk_event'
  | 'squad_join'
  | 'marketplace_subscription'
  | 'agent_registered'
  | 'order_placed'
  | 'order_filled'
  | 'order_cancelled'
  | 'message_sent'
  | 'mev_analyzed'
  | 'custom';

export interface JournalEntry {
  id: string;
  agentId: string;
  action: JournalAction;
  details: Record<string, unknown>;
  tags: string[];
  timestamp: string;
}

export interface JournalQueryOpts {
  type?: JournalAction;
  limit?: number;
  offset?: number;
}

export interface JournalStats {
  totalEntries: number;
  actionCounts: Record<string, number>;
  mostActiveHour: number | null;
}

const MAX_ENTRIES_PER_AGENT = 10_000;

export class JournalService {
  private entries: Map<string, JournalEntry[]> = new Map();
  private unsubscribers: Array<() => void> = [];

  constructor() {
    this.hookEventBus();
  }

  /**
   * Add a journal entry for an agent.
   */
  addEntry(agentId: string, action: JournalAction, details: Record<string, unknown>, tags: string[] = []): JournalEntry {
    const entry: JournalEntry = {
      id: uuid(),
      agentId,
      action,
      details,
      tags,
      timestamp: isoNow(),
    };

    if (!this.entries.has(agentId)) {
      this.entries.set(agentId, []);
    }

    const agentEntries = this.entries.get(agentId)!;
    agentEntries.push(entry);

    // Trim if exceeding max
    if (agentEntries.length > MAX_ENTRIES_PER_AGENT) {
      const trimmed = agentEntries.slice(-MAX_ENTRIES_PER_AGENT / 2);
      this.entries.set(agentId, trimmed);
    }

    eventBus.emit('journal.entry', {
      entryId: entry.id,
      agentId: entry.agentId,
      action: entry.action,
    });

    return structuredClone(entry);
  }

  /**
   * Get paginated journal for an agent with optional filtering.
   */
  getJournal(agentId: string, opts?: JournalQueryOpts): { entries: JournalEntry[]; total: number } {
    const all = this.entries.get(agentId) ?? [];
    const filtered = opts?.type
      ? all.filter((e) => e.action === opts.type)
      : all;

    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);

    // Return most recent first
    const sorted = [...filtered].reverse();
    const page = sorted.slice(offset, offset + limit);

    return {
      entries: page.map((e) => structuredClone(e)),
      total: filtered.length,
    };
  }

  /**
   * Get journal statistics for an agent.
   */
  getJournalStats(agentId: string): JournalStats {
    const all = this.entries.get(agentId) ?? [];

    const actionCounts: Record<string, number> = {};
    const hourCounts: Record<number, number> = {};

    for (const entry of all) {
      actionCounts[entry.action] = (actionCounts[entry.action] ?? 0) + 1;

      const hour = new Date(entry.timestamp).getUTCHours();
      hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    }

    let mostActiveHour: number | null = null;
    let maxCount = 0;
    for (const [hour, count] of Object.entries(hourCounts)) {
      if (count > maxCount) {
        maxCount = count;
        mostActiveHour = Number(hour);
      }
    }

    return {
      totalEntries: all.length,
      actionCounts,
      mostActiveHour,
    };
  }

  /**
   * Export full journal for an agent as JSON array.
   */
  exportJournal(agentId: string, _format: 'json' = 'json'): JournalEntry[] {
    const all = this.entries.get(agentId) ?? [];
    return all.map((e) => structuredClone(e));
  }

  /**
   * Hook into eventBus to automatically log significant events.
   */
  private hookEventBus(): void {
    const eventActionMap: Array<{ event: EventType; extract: (data: any) => { agentId: string; action: JournalAction; details: Record<string, unknown>; tags: string[] } | null }> = [
      {
        event: 'intent.executed',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'trade',
          details: { intentId: data.intentId, symbol: data.symbol, side: data.side, notionalUsd: data.notionalUsd },
          tags: ['trade', data.side, data.symbol],
        }),
      },
      {
        event: 'intent.rejected',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'risk_event',
          details: { intentId: data.intentId, reason: data.reason },
          tags: ['risk', 'rejected'],
        }),
      },
      {
        event: 'agent.registered',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'agent_registered',
          details: { name: data.name, strategyId: data.strategyId },
          tags: ['registration'],
        }),
      },
      {
        event: 'squad.joined',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'squad_join',
          details: { squadId: data.squadId },
          tags: ['squad'],
        }),
      },
      {
        event: 'order.limit.placed',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'order_placed',
          details: { orderId: data.orderId, type: 'limit', symbol: data.symbol, side: data.side, price: data.price },
          tags: ['order', 'limit'],
        }),
      },
      {
        event: 'order.stoploss.placed',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'order_placed',
          details: { orderId: data.orderId, type: 'stop-loss', symbol: data.symbol, triggerPrice: data.triggerPrice },
          tags: ['order', 'stop-loss'],
        }),
      },
      {
        event: 'order.limit.filled',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'order_filled',
          details: { orderId: data.orderId, type: 'limit' },
          tags: ['order', 'filled'],
        }),
      },
      {
        event: 'order.stoploss.triggered',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'order_filled',
          details: { orderId: data.orderId, type: 'stop-loss' },
          tags: ['order', 'triggered'],
        }),
      },
      {
        event: 'order.cancelled',
        extract: (data) => ({
          agentId: data.agentId,
          action: 'order_cancelled',
          details: { orderId: data.orderId },
          tags: ['order', 'cancelled'],
        }),
      },
      {
        event: 'message.sent',
        extract: (data) => ({
          agentId: data.from,
          action: 'message_sent',
          details: { messageId: data.messageId, to: data.to, type: data.type },
          tags: ['message'],
        }),
      },
      {
        event: 'mev.analyzed',
        extract: (data) => data.agentId ? ({
          agentId: data.agentId,
          action: 'mev_analyzed',
          details: { symbol: data.symbol, riskLevel: data.riskLevel },
          tags: ['mev'],
        }) : null,
      },
    ];

    for (const mapping of eventActionMap) {
      const unsub = eventBus.on(mapping.event, (_eventType: EventType, data: unknown) => {
        try {
          const extracted = mapping.extract(data);
          if (extracted) {
            this.addEntry(extracted.agentId, extracted.action, extracted.details, extracted.tags);
          }
        } catch {
          // swallow errors from event processing
        }
      });
      this.unsubscribers.push(unsub);
    }
  }

  /**
   * Cleanup event listeners. Useful for tests.
   */
  destroy(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
