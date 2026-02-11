import { describe, expect, it, vi } from 'vitest';
import { MessagingService } from '../src/services/messagingService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    apiKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10000,
    cashUsd: 10000,
    realizedPnlUsd: 0,
    peakEquityUsd: 10000,
    riskLimits: {
      maxPositionSizePct: 0.25,
      maxOrderNotionalUsd: 2500,
      maxGrossExposureUsd: 7500,
      dailyLossCapUsd: 1000,
      maxDrawdownPct: 0.2,
      cooldownSeconds: 3,
    },
    positions: {},
    dailyRealizedPnlUsd: {},
    riskRejectionsByReason: {},
    strategyId: 'momentum-v1',
  };
}

describe('MessagingService', () => {
  function setup() {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    state.agents['agent-3'] = makeAgent('agent-3', 'Agent 3');
    const store = createMockStore(state);
    const service = new MessagingService(store);

    // Wire up squad lookup
    const squads: Record<string, string[]> = {
      'squad-1': ['agent-1', 'agent-2', 'agent-3'],
    };
    service.setSquadMemberLookup((squadId: string) => squads[squadId] ?? null);

    return { state, store, service };
  }

  it('sends a message between agents', () => {
    const { service } = setup();
    const msg = service.sendMessage({
      from: 'agent-1',
      to: 'agent-2',
      type: 'trade-signal',
      payload: { symbol: 'SOL', signal: 'buy', confidence: 0.85 },
    });

    expect(msg.id).toBeDefined();
    expect(msg.from).toBe('agent-1');
    expect(msg.to).toBe('agent-2');
    expect(msg.type).toBe('trade-signal');
    expect(msg.payload.symbol).toBe('SOL');
    expect(msg.read).toBe(false);
    expect(msg.createdAt).toBeDefined();
  });

  it('rejects message from unknown sender', () => {
    const { service } = setup();
    expect(() =>
      service.sendMessage({
        from: 'ghost',
        to: 'agent-2',
        type: 'general',
        payload: { text: 'hello' },
      }),
    ).toThrow('Sender agent not found');
  });

  it('rejects message to unknown recipient', () => {
    const { service } = setup();
    expect(() =>
      service.sendMessage({
        from: 'agent-1',
        to: 'ghost',
        type: 'general',
        payload: { text: 'hello' },
      }),
    ).toThrow('Recipient agent not found');
  });

  it('retrieves inbox for an agent', () => {
    const { service } = setup();
    service.sendMessage({
      from: 'agent-1',
      to: 'agent-2',
      type: 'trade-signal',
      payload: { symbol: 'SOL' },
    });
    service.sendMessage({
      from: 'agent-3',
      to: 'agent-2',
      type: 'risk-alert',
      payload: { alert: 'high exposure' },
    });
    service.sendMessage({
      from: 'agent-1',
      to: 'agent-3',
      type: 'general',
      payload: { text: 'not for agent-2' },
    });

    const inbox = service.getInbox('agent-2');
    expect(inbox.length).toBe(2);
    // Most recent first
    expect(inbox[0].type).toBe('risk-alert');
    expect(inbox[1].type).toBe('trade-signal');
  });

  it('supports inbox limit', () => {
    const { service } = setup();
    for (let i = 0; i < 10; i++) {
      service.sendMessage({
        from: 'agent-1',
        to: 'agent-2',
        type: 'general',
        payload: { index: i },
      });
    }

    const limited = service.getInbox('agent-2', 3);
    expect(limited.length).toBe(3);
  });

  it('broadcasts message to a squad', () => {
    const { service } = setup();
    const msg = service.broadcastToSquad({
      from: 'agent-1',
      squadId: 'squad-1',
      type: 'strategy-update',
      payload: { newStrategy: 'mean-reversion-v1' },
    });

    expect(msg.id).toBeDefined();
    expect(msg.from).toBe('agent-1');
    expect(msg.squadId).toBe('squad-1');
    expect(msg.type).toBe('strategy-update');
  });

  it('rejects squad broadcast from non-member', () => {
    const { service } = setup();
    // squad-1 only has agent-1, agent-2, agent-3
    // Create a new agent not in squad
    const state = createDefaultState();
    state.agents['agent-4'] = makeAgent('agent-4', 'Agent 4');
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    const store = createMockStore(state);
    const svc = new MessagingService(store);
    svc.setSquadMemberLookup((squadId: string) => {
      if (squadId === 'squad-1') return ['agent-1'];
      return null;
    });

    expect(() =>
      svc.broadcastToSquad({
        from: 'agent-4',
        squadId: 'squad-1',
        type: 'general',
        payload: {},
      }),
    ).toThrow('not a member');
  });

  it('rejects squad broadcast to non-existent squad', () => {
    const { service } = setup();
    expect(() =>
      service.broadcastToSquad({
        from: 'agent-1',
        squadId: 'nonexistent',
        type: 'general',
        payload: {},
      }),
    ).toThrow('Squad not found');
  });

  it('retrieves squad messages', () => {
    const { service } = setup();
    service.broadcastToSquad({
      from: 'agent-1',
      squadId: 'squad-1',
      type: 'trade-signal',
      payload: { symbol: 'SOL', action: 'buy' },
    });
    service.broadcastToSquad({
      from: 'agent-2',
      squadId: 'squad-1',
      type: 'risk-alert',
      payload: { alert: 'drawdown' },
    });

    const msgs = service.getSquadMessages('squad-1');
    expect(msgs.length).toBe(2);
    // Most recent first
    expect(msgs[0].type).toBe('risk-alert');
    expect(msgs[1].type).toBe('trade-signal');
  });

  it('supports all message types', () => {
    const { service } = setup();
    const types = ['trade-signal', 'risk-alert', 'strategy-update', 'general'] as const;

    for (const type of types) {
      const msg = service.sendMessage({
        from: 'agent-1',
        to: 'agent-2',
        type,
        payload: { type },
      });
      expect(msg.type).toBe(type);
    }

    const inbox = service.getInbox('agent-2');
    expect(inbox.length).toBe(4);
  });
});
