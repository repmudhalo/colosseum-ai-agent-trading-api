/**
 * Alert System & Notifications Service.
 *
 * Agents can set price alerts, drawdown alerts, execution alerts, and risk breach alerts.
 * Triggered alerts are pushed through eventBus and stored in history.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export type AlertType =
  | 'price-above'
  | 'price-below'
  | 'drawdown-exceeded'
  | 'execution-completed'
  | 'risk-breach';

export interface AlertConfig {
  /** Symbol for price alerts */
  symbol?: string;
  /** Price threshold for price-above / price-below */
  priceUsd?: number;
  /** Drawdown percentage threshold (0..1) for drawdown-exceeded */
  drawdownPct?: number;
  /** Execution ID to watch for execution-completed */
  executionId?: string;
  /** Risk metric name for risk-breach */
  riskMetric?: string;
  /** Risk threshold value for risk-breach */
  riskThreshold?: number;
}

export interface Alert {
  id: string;
  agentId: string;
  type: AlertType;
  config: AlertConfig;
  status: 'active' | 'triggered' | 'deleted';
  createdAt: string;
  triggeredAt?: string;
}

export interface TriggeredAlert {
  alertId: string;
  agentId: string;
  type: AlertType;
  config: AlertConfig;
  triggeredAt: string;
  details: Record<string, unknown>;
}

export interface AlertState {
  marketPricesUsd: Record<string, number>;
  agents: Record<string, {
    peakEquityUsd: number;
    cashUsd: number;
    positions: Record<string, { symbol: string; quantity: number; avgEntryPriceUsd: number }>;
    riskLimits: {
      maxDrawdownPct: number;
      maxGrossExposureUsd: number;
    };
  }>;
  executions: Record<string, { status: string }>;
}

const VALID_ALERT_TYPES: AlertType[] = [
  'price-above',
  'price-below',
  'drawdown-exceeded',
  'execution-completed',
  'risk-breach',
];

const MAX_ALERTS = 10_000;
const MAX_HISTORY = 10_000;

export class AlertService {
  private alerts: Map<string, Alert> = new Map();
  private triggeredHistory: TriggeredAlert[] = [];

  constructor(private readonly store: StateStore) {}

  /**
   * Create a new alert for an agent.
   */
  createAlert(agentId: string, type: AlertType, config: AlertConfig): Alert {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    if (!VALID_ALERT_TYPES.includes(type)) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Invalid alert type. Must be one of: ${VALID_ALERT_TYPES.join(', ')}`,
      );
    }

    // Validate config based on type
    this.validateConfig(type, config);

    const alert: Alert = {
      id: uuid(),
      agentId,
      type,
      config,
      status: 'active',
      createdAt: isoNow(),
    };

    this.alerts.set(alert.id, alert);
    this.trimAlerts();

    eventBus.emit('alert.created', {
      alertId: alert.id,
      agentId,
      type,
      config,
    });

    return structuredClone(alert);
  }

  /**
   * Get all alerts for an agent.
   */
  getAlerts(agentId: string): Alert[] {
    return Array.from(this.alerts.values())
      .filter((a) => a.agentId === agentId && a.status !== 'deleted')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => structuredClone(a));
  }

  /**
   * Delete an alert by ID.
   */
  deleteAlert(alertId: string): { deleted: boolean } {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Alert not found.');
    }

    alert.status = 'deleted';

    eventBus.emit('alert.deleted', {
      alertId,
      agentId: alert.agentId,
      type: alert.type,
    });

    return { deleted: true };
  }

  /**
   * Get triggered alert history for an agent.
   */
  getHistory(agentId: string): TriggeredAlert[] {
    return this.triggeredHistory
      .filter((h) => h.agentId === agentId)
      .map((h) => structuredClone(h));
  }

  /**
   * Check all active alerts against current state and trigger matching ones.
   */
  checkAlerts(currentState?: AlertState): TriggeredAlert[] {
    const state = currentState ?? this.buildAlertState();
    const triggered: TriggeredAlert[] = [];

    for (const alert of this.alerts.values()) {
      if (alert.status !== 'active') continue;

      const result = this.evaluateAlert(alert, state);
      if (result) {
        alert.status = 'triggered';
        alert.triggeredAt = result.triggeredAt;

        triggered.push(result);
        this.triggeredHistory.push(result);

        eventBus.emit('alert.triggered', {
          alertId: result.alertId,
          agentId: result.agentId,
          type: result.type,
          details: result.details,
        });
      }
    }

    this.trimHistory();
    return triggered;
  }

  /* ─── Internals ──────────────────────────────────────────────────────── */

  private validateConfig(type: AlertType, config: AlertConfig): void {
    switch (type) {
      case 'price-above':
      case 'price-below':
        if (!config.symbol) {
          throw new DomainError(ErrorCode.InvalidPayload, 400, 'symbol is required for price alerts.');
        }
        if (typeof config.priceUsd !== 'number' || config.priceUsd <= 0) {
          throw new DomainError(ErrorCode.InvalidPayload, 400, 'priceUsd must be a positive number for price alerts.');
        }
        break;
      case 'drawdown-exceeded':
        if (typeof config.drawdownPct !== 'number' || config.drawdownPct <= 0 || config.drawdownPct > 1) {
          throw new DomainError(ErrorCode.InvalidPayload, 400, 'drawdownPct must be between 0 and 1.');
        }
        break;
      case 'execution-completed':
        if (!config.executionId) {
          throw new DomainError(ErrorCode.InvalidPayload, 400, 'executionId is required for execution-completed alerts.');
        }
        break;
      case 'risk-breach':
        // Flexible — no strict requirements beyond having the type
        break;
    }
  }

  private evaluateAlert(alert: Alert, state: AlertState): TriggeredAlert | null {
    const now = isoNow();

    switch (alert.type) {
      case 'price-above': {
        const price = state.marketPricesUsd[alert.config.symbol!];
        if (price !== undefined && price > alert.config.priceUsd!) {
          return {
            alertId: alert.id,
            agentId: alert.agentId,
            type: alert.type,
            config: alert.config,
            triggeredAt: now,
            details: { currentPrice: price, threshold: alert.config.priceUsd },
          };
        }
        return null;
      }

      case 'price-below': {
        const price = state.marketPricesUsd[alert.config.symbol!];
        if (price !== undefined && price < alert.config.priceUsd!) {
          return {
            alertId: alert.id,
            agentId: alert.agentId,
            type: alert.type,
            config: alert.config,
            triggeredAt: now,
            details: { currentPrice: price, threshold: alert.config.priceUsd },
          };
        }
        return null;
      }

      case 'drawdown-exceeded': {
        const agentState = state.agents[alert.agentId];
        if (!agentState) return null;

        const positionValue = Object.values(agentState.positions).reduce((sum, pos) => {
          const px = state.marketPricesUsd[pos.symbol] ?? pos.avgEntryPriceUsd;
          return sum + pos.quantity * px;
        }, 0);
        const equity = agentState.cashUsd + positionValue;
        const peak = agentState.peakEquityUsd;

        if (peak > 0) {
          const drawdown = (peak - equity) / peak;
          if (drawdown > alert.config.drawdownPct!) {
            return {
              alertId: alert.id,
              agentId: alert.agentId,
              type: alert.type,
              config: alert.config,
              triggeredAt: now,
              details: { currentDrawdown: Number(drawdown.toFixed(4)), threshold: alert.config.drawdownPct },
            };
          }
        }
        return null;
      }

      case 'execution-completed': {
        const execution = state.executions[alert.config.executionId!];
        if (execution && execution.status === 'filled') {
          return {
            alertId: alert.id,
            agentId: alert.agentId,
            type: alert.type,
            config: alert.config,
            triggeredAt: now,
            details: { executionId: alert.config.executionId, status: execution.status },
          };
        }
        return null;
      }

      case 'risk-breach': {
        const agentState = state.agents[alert.agentId];
        if (!agentState) return null;

        // Check gross exposure breach
        const grossExposure = Object.values(agentState.positions).reduce((sum, pos) => {
          const px = state.marketPricesUsd[pos.symbol] ?? pos.avgEntryPriceUsd;
          return sum + Math.abs(pos.quantity * px);
        }, 0);

        if (grossExposure > agentState.riskLimits.maxGrossExposureUsd) {
          return {
            alertId: alert.id,
            agentId: alert.agentId,
            type: alert.type,
            config: alert.config,
            triggeredAt: now,
            details: {
              grossExposure: Number(grossExposure.toFixed(2)),
              limit: agentState.riskLimits.maxGrossExposureUsd,
            },
          };
        }
        return null;
      }

      default:
        return null;
    }
  }

  private buildAlertState(): AlertState {
    const snapshot = this.store.snapshot();
    return {
      marketPricesUsd: snapshot.marketPricesUsd,
      agents: Object.fromEntries(
        Object.entries(snapshot.agents).map(([id, agent]) => [id, {
          peakEquityUsd: agent.peakEquityUsd,
          cashUsd: agent.cashUsd,
          positions: agent.positions,
          riskLimits: {
            maxDrawdownPct: agent.riskLimits.maxDrawdownPct,
            maxGrossExposureUsd: agent.riskLimits.maxGrossExposureUsd,
          },
        }]),
      ),
      executions: Object.fromEntries(
        Object.entries(snapshot.executions).map(([id, ex]) => [id, { status: ex.status }]),
      ),
    };
  }

  private trimAlerts(): void {
    if (this.alerts.size > MAX_ALERTS) {
      const sorted = Array.from(this.alerts.entries())
        .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
      const toRemove = sorted.slice(0, this.alerts.size - MAX_ALERTS / 2);
      for (const [id] of toRemove) {
        this.alerts.delete(id);
      }
    }
  }

  private trimHistory(): void {
    if (this.triggeredHistory.length > MAX_HISTORY) {
      this.triggeredHistory = this.triggeredHistory.slice(-MAX_HISTORY / 2);
    }
  }
}
