/**
 * AutonomousGuard — ported from bot repo's AutonomousGuard pattern.
 *
 * Protects per-agent autonomous trading with:
 *  - Max drawdown halt (permanent until manual reset)
 *  - Cooldown after consecutive failures (time-based backoff)
 *  - General cooldown enforcement
 */

export interface AutonomousGuardConfig {
  maxDrawdownStopPct: number;
  cooldownMs: number;
  cooldownAfterConsecutiveFailures: number;
}

export interface AutonomousAgentState {
  cooldownUntilMs: number;
  halted: boolean;
  haltReason: string | null;
  consecutiveFailures: number;
  totalEvaluations: number;
  totalIntentsCreated: number;
  totalSkipped: number;
  lastEvaluationAt: string | null;
  lastIntentCreatedAt: string | null;
}

export interface AutonomousDecision {
  allowTrading: boolean;
  pauseRequested: boolean;
  reason?: string;
}

export const createDefaultAgentAutonomousState = (): AutonomousAgentState => ({
  cooldownUntilMs: 0,
  halted: false,
  haltReason: null,
  consecutiveFailures: 0,
  totalEvaluations: 0,
  totalIntentsCreated: 0,
  totalSkipped: 0,
  lastEvaluationAt: null,
  lastIntentCreatedAt: null,
});

export class AutonomousGuard {
  constructor(private readonly config: AutonomousGuardConfig) {}

  evaluate(input: {
    nowMs: number;
    drawdownPct: number;
    agentState: AutonomousAgentState;
  }): AutonomousDecision {
    const { nowMs, drawdownPct, agentState } = input;

    // Max drawdown halt — permanent until manual reset
    if (!agentState.halted && drawdownPct >= this.config.maxDrawdownStopPct) {
      agentState.halted = true;
      agentState.haltReason = `max drawdown stop triggered (${drawdownPct.toFixed(2)}% >= ${this.config.maxDrawdownStopPct}%)`;
      return {
        allowTrading: false,
        pauseRequested: true,
        reason: agentState.haltReason,
      };
    }

    if (agentState.halted) {
      return {
        allowTrading: false,
        pauseRequested: false,
        reason: agentState.haltReason ?? 'autonomous halt active',
      };
    }

    // Cooldown currently active — wait it out
    if (nowMs < agentState.cooldownUntilMs) {
      return {
        allowTrading: false,
        pauseRequested: false,
        reason: `cooldown until ${new Date(agentState.cooldownUntilMs).toISOString()}`,
      };
    }

    // Consecutive failure threshold — trigger cooldown
    if (agentState.consecutiveFailures >= this.config.cooldownAfterConsecutiveFailures) {
      agentState.cooldownUntilMs = nowMs + this.config.cooldownMs;
      agentState.consecutiveFailures = 0; // reset after triggering cooldown
      return {
        allowTrading: false,
        pauseRequested: false,
        reason: `cooldown triggered after ${this.config.cooldownAfterConsecutiveFailures} consecutive failures, paused for ${this.config.cooldownMs}ms`,
      };
    }

    return { allowTrading: true, pauseRequested: false };
  }

  getConfig(): AutonomousGuardConfig {
    return { ...this.config };
  }
}
