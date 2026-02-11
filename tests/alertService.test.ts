import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AlertService, AlertState } from '../src/services/alertService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { eventBus } from '../src/infra/eventBus.js';

function createMockStore(state: AppState) {
  return {
    snapshot: () => structuredClone(state),
    transaction: vi.fn(),
    init: vi.fn(),
    flush: vi.fn(),
  } as any;
}

function makeAgent(id: string, name: string, overrides?: Partial<Agent>): Agent {
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
    ...overrides,
  };
}

describe('AlertService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup(agentOverrides?: Partial<Agent>) {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1', agentOverrides);
    state.agents['agent-2'] = makeAgent('agent-2', 'Agent 2');
    state.marketPricesUsd['SOL'] = 100;
    const store = createMockStore(state);
    const service = new AlertService(store);
    return { state, store, service };
  }

  it('creates a price-above alert', () => {
    const { service } = setup();
    const alert = service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 150,
    });

    expect(alert.id).toBeDefined();
    expect(alert.agentId).toBe('agent-1');
    expect(alert.type).toBe('price-above');
    expect(alert.config.symbol).toBe('SOL');
    expect(alert.config.priceUsd).toBe(150);
    expect(alert.status).toBe('active');
  });

  it('emits alert.created event', () => {
    const { service } = setup();
    const events: unknown[] = [];
    eventBus.on('alert.created', (_event, data) => events.push(data));

    service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 150,
    });

    expect(events.length).toBe(1);
    expect((events[0] as any).type).toBe('price-above');
  });

  it('rejects alert for unknown agent', () => {
    const { service } = setup();
    expect(() =>
      service.createAlert('ghost', 'price-above', { symbol: 'SOL', priceUsd: 150 }),
    ).toThrow('Agent not found');
  });

  it('validates config for price alerts', () => {
    const { service } = setup();
    expect(() =>
      service.createAlert('agent-1', 'price-above', {}),
    ).toThrow('symbol is required');

    expect(() =>
      service.createAlert('agent-1', 'price-below', { symbol: 'SOL' }),
    ).toThrow('priceUsd must be a positive number');
  });

  it('triggers price-above alert when price exceeds threshold', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 90,
    });

    const mockState: AlertState = {
      marketPricesUsd: { SOL: 95 },
      agents: {},
      executions: {},
    };

    const triggered = service.checkAlerts(mockState);
    expect(triggered.length).toBe(1);
    expect(triggered[0].type).toBe('price-above');
    expect((triggered[0].details as any).currentPrice).toBe(95);
  });

  it('triggers price-below alert when price drops below threshold', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'price-below', {
      symbol: 'SOL',
      priceUsd: 110,
    });

    const mockState: AlertState = {
      marketPricesUsd: { SOL: 105 },
      agents: {},
      executions: {},
    };

    const triggered = service.checkAlerts(mockState);
    expect(triggered.length).toBe(1);
    expect(triggered[0].type).toBe('price-below');
  });

  it('triggers drawdown-exceeded alert', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'drawdown-exceeded', {
      drawdownPct: 0.1,
    });

    const mockState: AlertState = {
      marketPricesUsd: { SOL: 100 },
      agents: {
        'agent-1': {
          peakEquityUsd: 10000,
          cashUsd: 8500,
          positions: {},
          riskLimits: { maxDrawdownPct: 0.2, maxGrossExposureUsd: 7500 },
        },
      },
      executions: {},
    };

    const triggered = service.checkAlerts(mockState);
    expect(triggered.length).toBe(1);
    expect(triggered[0].type).toBe('drawdown-exceeded');
    expect((triggered[0].details as any).currentDrawdown).toBe(0.15);
  });

  it('triggers execution-completed alert', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'execution-completed', {
      executionId: 'exec-123',
    });

    const mockState: AlertState = {
      marketPricesUsd: {},
      agents: {},
      executions: { 'exec-123': { status: 'filled' } },
    };

    const triggered = service.checkAlerts(mockState);
    expect(triggered.length).toBe(1);
    expect(triggered[0].type).toBe('execution-completed');
  });

  it('does not trigger already-triggered alerts', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 90,
    });

    const mockState: AlertState = {
      marketPricesUsd: { SOL: 95 },
      agents: {},
      executions: {},
    };

    // First check triggers
    const first = service.checkAlerts(mockState);
    expect(first.length).toBe(1);

    // Second check should not re-trigger (status is now 'triggered')
    const second = service.checkAlerts(mockState);
    expect(second.length).toBe(0);
  });

  it('deletes an alert', () => {
    const { service } = setup();
    const alert = service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 150,
    });

    const result = service.deleteAlert(alert.id);
    expect(result.deleted).toBe(true);

    // Alert should no longer appear in active list
    const alerts = service.getAlerts('agent-1');
    expect(alerts.length).toBe(0);
  });

  it('emits alert.deleted event', () => {
    const { service } = setup();
    const events: unknown[] = [];
    eventBus.on('alert.deleted', (_event, data) => events.push(data));

    const alert = service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 150,
    });
    service.deleteAlert(alert.id);

    expect(events.length).toBe(1);
    expect((events[0] as any).alertId).toBe(alert.id);
  });

  it('stores triggered alerts in history', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'price-above', {
      symbol: 'SOL',
      priceUsd: 90,
    });

    const mockState: AlertState = {
      marketPricesUsd: { SOL: 95 },
      agents: {},
      executions: {},
    };

    service.checkAlerts(mockState);

    const history = service.getHistory('agent-1');
    expect(history.length).toBe(1);
    expect(history[0].type).toBe('price-above');
    expect(history[0].triggeredAt).toBeDefined();
  });

  it('getAlerts returns only alerts for specified agent', () => {
    const { service } = setup();
    service.createAlert('agent-1', 'price-above', { symbol: 'SOL', priceUsd: 150 });
    service.createAlert('agent-2', 'price-below', { symbol: 'SOL', priceUsd: 80 });

    const agent1Alerts = service.getAlerts('agent-1');
    expect(agent1Alerts.length).toBe(1);
    expect(agent1Alerts[0].agentId).toBe('agent-1');

    const agent2Alerts = service.getAlerts('agent-2');
    expect(agent2Alerts.length).toBe(1);
    expect(agent2Alerts[0].agentId).toBe('agent-2');
  });

  it('throws when deleting non-existent alert', () => {
    const { service } = setup();
    expect(() => service.deleteAlert('nonexistent')).toThrow('Alert not found');
  });
});
