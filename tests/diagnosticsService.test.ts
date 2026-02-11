import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DiagnosticsService } from '../src/services/diagnosticsService.js';
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

function createMockAgentService(store: any) {
  return {
    register: vi.fn().mockImplementation(async (data: any) => {
      const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        name: data.name,
        apiKey: `key-${id}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startingCapitalUsd: data.startingCapitalUsd ?? 10000,
        cashUsd: data.startingCapitalUsd ?? 10000,
        realizedPnlUsd: 0,
        peakEquityUsd: data.startingCapitalUsd ?? 10000,
        riskLimits: {},
        positions: {},
        dailyRealizedPnlUsd: {},
        riskRejectionsByReason: {},
        strategyId: 'momentum-v1',
      };
    }),
    getById: vi.fn().mockReturnValue({ id: 'test', name: 'test' }),
  } as any;
}

function createMockIntentService() {
  return {
    create: vi.fn(),
    getById: vi.fn(),
  } as any;
}

describe('DiagnosticsService', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  function setup() {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Agent 1');
    const store = createMockStore(state);
    const agentService = createMockAgentService(store);
    const intentService = createMockIntentService();
    const service = new DiagnosticsService(store, agentService, intentService);
    return { state, store, service, agentService, intentService };
  }

  it('returns system health with valid structure', () => {
    const { service } = setup();
    const health = service.getSystemHealth();

    expect(health.status).toBe('healthy');
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(health.memoryUsage.rssBytes).toBeGreaterThan(0);
    expect(health.memoryUsage.heapUsedBytes).toBeGreaterThan(0);
    expect(health.memoryUsage.heapTotalBytes).toBeGreaterThan(0);
    expect(typeof health.memoryUsage.heapUsedPct).toBe('number');
    expect(health.totalEvents).toBe(0);
    expect(health.checkedAt).toBeDefined();
  });

  it('tracks events when listening', () => {
    const { service } = setup();
    service.startListening();

    eventBus.emit('price.updated', { symbol: 'SOL', priceUsd: 100 });
    eventBus.emit('price.updated', { symbol: 'SOL', priceUsd: 101 });
    eventBus.emit('intent.created', { intentId: '123' });

    const health = service.getSystemHealth();
    expect(health.totalEvents).toBe(3);
    expect(health.eventCounts['price.updated']).toBe(2);
    expect(health.eventCounts['intent.created']).toBe(1);

    service.stopListening();
  });

  it('returns per-service status', () => {
    const { service } = setup();
    const statuses = service.getServiceStatus();

    expect(statuses.length).toBeGreaterThanOrEqual(4);
    expect(statuses.every((s) => s.status === 'ok' || s.status === 'degraded')).toBe(true);
    expect(statuses.every((s) => s.name && s.checkedAt)).toBe(true);

    const stateStore = statuses.find((s) => s.name === 'state-store');
    expect(stateStore).toBeDefined();
    expect(stateStore!.status).toBe('ok');
  });

  it('logs and retrieves errors', () => {
    const { service } = setup();

    service.logError('Something broke', 'test-service', { key: 'value' });
    service.logError('Another failure', 'another-service');

    const errors = service.getErrorLog();
    expect(errors.length).toBe(2);
    // Newest first
    expect(errors[0].message).toBe('Another failure');
    expect(errors[1].message).toBe('Something broke');
    expect(errors[1].context).toEqual({ key: 'value' });
  });

  it('limits error log retrieval', () => {
    const { service } = setup();

    for (let i = 0; i < 20; i++) {
      service.logError(`Error ${i}`, 'test');
    }

    const limited = service.getErrorLog(5);
    expect(limited.length).toBe(5);
  });

  it('runs self-test successfully', async () => {
    const { service } = setup();
    const result = await service.runSelfTest();

    expect(result.passed).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(4);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.ranAt).toBeDefined();

    // All steps should pass
    for (const step of result.steps) {
      expect(step.passed).toBe(true);
      expect(step.name).toBeDefined();
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('self-test includes specific steps', async () => {
    const { service } = setup();
    const result = await service.runSelfTest();

    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toContain('register-test-agent');
    expect(stepNames).toContain('verify-agent-exists');
    expect(stepNames).toContain('state-store-read');
    expect(stepNames).toContain('event-bus-roundtrip');
    expect(stepNames).toContain('memory-health');
  });

  it('self-test reports failure when agent registration fails', async () => {
    const { service, agentService } = setup();
    agentService.register.mockRejectedValueOnce(new Error('Registration failed'));

    const result = await service.runSelfTest();
    const regStep = result.steps.find((s) => s.name === 'register-test-agent');
    expect(regStep?.passed).toBe(false);
    expect(regStep?.error).toContain('Registration failed');
    expect(result.passed).toBe(false);
  });

  it('recent errors affect health status', () => {
    const { service } = setup();
    service.startListening();

    // Emit some events so totalEvents > 0
    eventBus.emit('price.updated', { symbol: 'SOL', priceUsd: 100 });

    // Log many recent errors
    for (let i = 0; i < 15; i++) {
      service.logError(`Error ${i}`, 'test');
    }

    const health = service.getSystemHealth();
    // With 15 recent errors, status should be degraded
    expect(health.recentErrors).toBe(15);
    expect(health.status === 'degraded' || health.status === 'unhealthy').toBe(true);

    service.stopListening();
  });
});
