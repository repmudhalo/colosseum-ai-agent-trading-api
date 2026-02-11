import { afterEach, describe, expect, it } from 'vitest';
import { JournalService } from '../src/services/journalService.js';
import { eventBus } from '../src/infra/eventBus.js';

function createService(): JournalService {
  return new JournalService();
}

describe('JournalService', () => {
  let service: JournalService;

  afterEach(() => {
    service?.destroy();
    eventBus.clear();
  });

  it('adds a journal entry and retrieves it', () => {
    service = createService();
    const entry = service.addEntry('agent-1', 'trade', { symbol: 'SOL', side: 'buy' }, ['trade', 'buy']);

    expect(entry.id).toBeDefined();
    expect(entry.agentId).toBe('agent-1');
    expect(entry.action).toBe('trade');
    expect(entry.details.symbol).toBe('SOL');
    expect(entry.tags).toContain('trade');
    expect(entry.timestamp).toBeDefined();

    const { entries, total } = service.getJournal('agent-1');
    expect(total).toBe(1);
    expect(entries[0].id).toBe(entry.id);
  });

  it('returns paginated journal with limit and offset', () => {
    service = createService();
    for (let i = 0; i < 10; i++) {
      service.addEntry('agent-1', 'trade', { index: i });
    }

    // Default: most recent first
    const page1 = service.getJournal('agent-1', { limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.entries[0].details.index).toBe(9); // most recent

    const page2 = service.getJournal('agent-1', { limit: 3, offset: 3 });
    expect(page2.entries).toHaveLength(3);
    expect(page2.entries[0].details.index).toBe(6);
  });

  it('filters journal by action type', () => {
    service = createService();
    service.addEntry('agent-1', 'trade', { symbol: 'SOL' });
    service.addEntry('agent-1', 'risk_event', { reason: 'drawdown' });
    service.addEntry('agent-1', 'trade', { symbol: 'BONK' });
    service.addEntry('agent-1', 'squad_join', { squadId: 'squad-1' });

    const trades = service.getJournal('agent-1', { type: 'trade' });
    expect(trades.total).toBe(2);
    expect(trades.entries.every((e) => e.action === 'trade')).toBe(true);

    const risk = service.getJournal('agent-1', { type: 'risk_event' });
    expect(risk.total).toBe(1);
  });

  it('computes journal stats correctly', () => {
    service = createService();
    service.addEntry('agent-1', 'trade', {});
    service.addEntry('agent-1', 'trade', {});
    service.addEntry('agent-1', 'risk_event', {});
    service.addEntry('agent-1', 'squad_join', {});

    const stats = service.getJournalStats('agent-1');
    expect(stats.totalEntries).toBe(4);
    expect(stats.actionCounts['trade']).toBe(2);
    expect(stats.actionCounts['risk_event']).toBe(1);
    expect(stats.actionCounts['squad_join']).toBe(1);
    expect(stats.mostActiveHour).toBeTypeOf('number');
  });

  it('returns empty stats for unknown agent', () => {
    service = createService();
    const stats = service.getJournalStats('nonexistent');
    expect(stats.totalEntries).toBe(0);
    expect(stats.actionCounts).toEqual({});
    expect(stats.mostActiveHour).toBeNull();
  });

  it('exports journal as JSON array', () => {
    service = createService();
    service.addEntry('agent-1', 'trade', { symbol: 'SOL' });
    service.addEntry('agent-1', 'risk_event', { reason: 'cap' });

    const exported = service.exportJournal('agent-1');
    expect(Array.isArray(exported)).toBe(true);
    expect(exported).toHaveLength(2);
    expect(exported[0].action).toBe('trade');
    expect(exported[1].action).toBe('risk_event');
  });

  it('returns empty export for unknown agent', () => {
    service = createService();
    const exported = service.exportJournal('ghost');
    expect(exported).toEqual([]);
  });

  it('auto-logs events from eventBus', () => {
    service = createService();

    // Simulate an intent.executed event
    eventBus.emit('intent.executed', {
      intentId: 'intent-1',
      agentId: 'agent-1',
      symbol: 'SOL',
      side: 'buy',
      notionalUsd: 1000,
    });

    const { entries, total } = service.getJournal('agent-1');
    expect(total).toBe(1);
    expect(entries[0].action).toBe('trade');
    expect(entries[0].details.symbol).toBe('SOL');
    expect(entries[0].tags).toContain('buy');
  });

  it('auto-logs agent.registered events', () => {
    service = createService();

    eventBus.emit('agent.registered', {
      agentId: 'agent-2',
      name: 'TestBot',
      strategyId: 'momentum-v1',
    });

    const { entries } = service.getJournal('agent-2');
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('agent_registered');
    expect(entries[0].details.name).toBe('TestBot');
  });

  it('auto-logs squad.joined events', () => {
    service = createService();

    eventBus.emit('squad.joined', {
      agentId: 'agent-3',
      squadId: 'squad-1',
    });

    const { entries } = service.getJournal('agent-3');
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('squad_join');
    expect(entries[0].details.squadId).toBe('squad-1');
  });

  it('returns empty journal for agent with no entries', () => {
    service = createService();
    const { entries, total } = service.getJournal('ghost');
    expect(entries).toEqual([]);
    expect(total).toBe(0);
  });
});
