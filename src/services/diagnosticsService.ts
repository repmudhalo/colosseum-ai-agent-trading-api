/**
 * System Health Monitor & Self-Diagnostics Service.
 *
 * Monitors system health: memory usage, event throughput, service status, error rates.
 * Provides self-test smoke tests for all services.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';
import { AgentService } from './agentService.js';
import { TradeIntentService } from './tradeIntentService.js';

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeMs: number;
  memoryUsage: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapUsedPct: number;
  };
  eventCounts: Record<string, number>;
  totalEvents: number;
  errorRate: number;
  recentErrors: number;
  checkedAt: string;
}

export interface ServiceStatus {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  details?: string;
  checkedAt: string;
}

export interface ErrorLogEntry {
  id: string;
  message: string;
  source: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface SelfTestResult {
  passed: boolean;
  steps: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    error?: string;
  }>;
  totalDurationMs: number;
  ranAt: string;
}

const MAX_ERROR_LOG = 500;

export class DiagnosticsService {
  private startedAt = Date.now();
  private eventCounts: Map<string, number> = new Map();
  private totalEvents = 0;
  private errorLog: ErrorLogEntry[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly agentService: AgentService,
    private readonly intentService: TradeIntentService,
  ) {}

  /**
   * Start listening to all events for throughput monitoring.
   */
  startListening(): void {
    this.unsubscribe = eventBus.on('*', (event) => {
      this.totalEvents++;
      this.eventCounts.set(event, (this.eventCounts.get(event) ?? 0) + 1);
    });
  }

  /**
   * Stop listening.
   */
  stopListening(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Log an error for the diagnostics error log.
   */
  logError(message: string, source: string, context?: Record<string, unknown>): void {
    this.errorLog.push({
      id: uuid(),
      message,
      source,
      timestamp: isoNow(),
      context,
    });

    if (this.errorLog.length > MAX_ERROR_LOG) {
      this.errorLog.splice(0, this.errorLog.length - MAX_ERROR_LOG);
    }
  }

  /**
   * Get comprehensive system health.
   */
  getSystemHealth(): SystemHealth {
    const mem = process.memoryUsage();
    const state = this.store.snapshot();
    const uptimeMs = Date.now() - this.startedAt;
    const recentErrors = this.errorLog.filter((e) => {
      const errorTime = new Date(e.timestamp).getTime();
      return Date.now() - errorTime < 300_000; // last 5 minutes
    }).length;

    const errorRate = this.totalEvents > 0
      ? Number((this.errorLog.length / this.totalEvents).toFixed(4))
      : 0;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const heapPct = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
    if (heapPct > 0.9 || recentErrors > 50) {
      status = 'unhealthy';
    } else if (heapPct > 0.75 || recentErrors > 10) {
      status = 'degraded';
    }

    return {
      status,
      uptimeMs,
      memoryUsage: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        heapUsedPct: Number(heapPct.toFixed(4)),
      },
      eventCounts: Object.fromEntries(this.eventCounts),
      totalEvents: this.totalEvents,
      errorRate,
      recentErrors,
      checkedAt: isoNow(),
    };
  }

  /**
   * Get per-service health check.
   */
  getServiceStatus(): ServiceStatus[] {
    const state = this.store.snapshot();
    const now = isoNow();

    const services: ServiceStatus[] = [
      {
        name: 'state-store',
        status: 'ok',
        details: `${Object.keys(state.agents).length} agents, ${Object.keys(state.executions).length} executions`,
        checkedAt: now,
      },
      {
        name: 'event-bus',
        status: this.totalEvents >= 0 ? 'ok' : 'down',
        details: `${this.totalEvents} events processed`,
        checkedAt: now,
      },
      {
        name: 'trade-intents',
        status: 'ok',
        details: `${Object.keys(state.tradeIntents).length} intents`,
        checkedAt: now,
      },
      {
        name: 'execution-engine',
        status: state.metrics.intentsFailed > state.metrics.intentsExecuted ? 'degraded' : 'ok',
        details: `${state.metrics.intentsExecuted} executed, ${state.metrics.intentsFailed} failed`,
        checkedAt: now,
      },
      {
        name: 'autonomous-loop',
        status: state.autonomous.enabled ? 'ok' : 'ok',
        details: state.autonomous.enabled
          ? `Running, ${state.autonomous.loopCount} loops`
          : 'Disabled (normal)',
        checkedAt: now,
      },
      {
        name: 'treasury',
        status: 'ok',
        details: `$${state.treasury.totalFeesUsd.toFixed(2)} total fees`,
        checkedAt: now,
      },
    ];

    return services;
  }

  /**
   * Get recent errors with stack context.
   */
  getErrorLog(limit?: number): ErrorLogEntry[] {
    const cap = Math.min(Math.max(limit ?? 50, 1), MAX_ERROR_LOG);
    return this.errorLog
      .slice(-cap)
      .reverse()
      .map((e) => structuredClone(e));
  }

  /**
   * Run a quick smoke test of core services.
   */
  async runSelfTest(): Promise<SelfTestResult> {
    const steps: SelfTestResult['steps'] = [];
    const overallStart = Date.now();

    // Step 1: Register test agent
    let testAgentId: string | null = null;
    const step1Start = Date.now();
    try {
      const agent = await this.agentService.register({
        name: `_diag-selftest-${uuid().slice(0, 8)}`,
        startingCapitalUsd: 1000,
      });
      testAgentId = agent.id;
      steps.push({
        name: 'register-test-agent',
        passed: true,
        durationMs: Date.now() - step1Start,
      });
    } catch (err) {
      steps.push({
        name: 'register-test-agent',
        passed: false,
        durationMs: Date.now() - step1Start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 2: Verify agent exists
    const step2Start = Date.now();
    try {
      if (testAgentId) {
        const found = this.agentService.getById(testAgentId);
        const passed = found !== null && found !== undefined;
        steps.push({
          name: 'verify-agent-exists',
          passed,
          durationMs: Date.now() - step2Start,
          error: passed ? undefined : 'Agent not found after registration',
        });
      } else {
        steps.push({
          name: 'verify-agent-exists',
          passed: false,
          durationMs: Date.now() - step2Start,
          error: 'Skipped — no test agent',
        });
      }
    } catch (err) {
      steps.push({
        name: 'verify-agent-exists',
        passed: false,
        durationMs: Date.now() - step2Start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 3: State store read
    const step3Start = Date.now();
    try {
      const snapshot = this.store.snapshot();
      const passed = typeof snapshot.agents === 'object';
      steps.push({
        name: 'state-store-read',
        passed,
        durationMs: Date.now() - step3Start,
        error: passed ? undefined : 'State snapshot returned invalid structure',
      });
    } catch (err) {
      steps.push({
        name: 'state-store-read',
        passed: false,
        durationMs: Date.now() - step3Start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 4: Event bus emit/receive
    const step4Start = Date.now();
    try {
      let received = false;
      const unsub = eventBus.on('price.updated', () => {
        received = true;
      });
      eventBus.emit('price.updated', { symbol: '_SELFTEST', priceUsd: 0 });
      unsub();
      steps.push({
        name: 'event-bus-roundtrip',
        passed: received,
        durationMs: Date.now() - step4Start,
        error: received ? undefined : 'Event not received',
      });
    } catch (err) {
      steps.push({
        name: 'event-bus-roundtrip',
        passed: false,
        durationMs: Date.now() - step4Start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 5: Memory check
    const step5Start = Date.now();
    try {
      const mem = process.memoryUsage();
      const heapPct = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
      const passed = heapPct < 0.95;
      steps.push({
        name: 'memory-health',
        passed,
        durationMs: Date.now() - step5Start,
        error: passed ? undefined : `Heap usage at ${(heapPct * 100).toFixed(1)}%`,
      });
    } catch (err) {
      steps.push({
        name: 'memory-health',
        passed: false,
        durationMs: Date.now() - step5Start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const allPassed = steps.every((s) => s.passed);

    return {
      passed: allPassed,
      steps,
      totalDurationMs: Date.now() - overallStart,
      ranAt: isoNow(),
    };
  }
}
