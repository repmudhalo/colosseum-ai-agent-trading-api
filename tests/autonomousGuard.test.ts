import { describe, it, expect } from 'vitest';
import {
  AutonomousGuard,
  createDefaultAgentAutonomousState,
} from '../src/domain/autonomous/autonomousGuard.js';

describe('AutonomousGuard', () => {
  const defaultConfig = {
    maxDrawdownStopPct: 12,
    cooldownMs: 120_000,
    cooldownAfterConsecutiveFailures: 2,
  };

  it('allows trading when no conditions are violated', () => {
    const guard = new AutonomousGuard(defaultConfig);
    const state = createDefaultAgentAutonomousState();

    const decision = guard.evaluate({
      nowMs: Date.now(),
      drawdownPct: 5,
      agentState: state,
    });

    expect(decision.allowTrading).toBe(true);
    expect(decision.pauseRequested).toBe(false);
  });

  it('halts on max drawdown and stays halted', () => {
    const guard = new AutonomousGuard(defaultConfig);
    const state = createDefaultAgentAutonomousState();

    const first = guard.evaluate({
      nowMs: Date.now(),
      drawdownPct: 15,
      agentState: state,
    });

    expect(first.allowTrading).toBe(false);
    expect(first.pauseRequested).toBe(true);
    expect(state.halted).toBe(true);

    // Subsequent call even with lower drawdown — still halted
    const second = guard.evaluate({
      nowMs: Date.now(),
      drawdownPct: 2,
      agentState: state,
    });

    expect(second.allowTrading).toBe(false);
    expect(second.reason).toContain('max drawdown stop triggered');
  });

  it('triggers cooldown after consecutive failures', () => {
    const guard = new AutonomousGuard(defaultConfig);
    const state = createDefaultAgentAutonomousState();
    state.consecutiveFailures = 2;
    const now = Date.now();

    const decision = guard.evaluate({
      nowMs: now,
      drawdownPct: 3,
      agentState: state,
    });

    expect(decision.allowTrading).toBe(false);
    expect(decision.reason).toContain('cooldown');
    expect(state.cooldownUntilMs).toBe(now + 120_000);
    expect(state.consecutiveFailures).toBe(0); // reset after triggering cooldown
  });

  it('blocks during cooldown period', () => {
    const guard = new AutonomousGuard(defaultConfig);
    const state = createDefaultAgentAutonomousState();
    const now = Date.now();
    state.cooldownUntilMs = now + 60_000;

    const decision = guard.evaluate({
      nowMs: now,
      drawdownPct: 1,
      agentState: state,
    });

    expect(decision.allowTrading).toBe(false);
    expect(decision.reason).toContain('cooldown until');
  });

  it('allows trading after cooldown expires', () => {
    const guard = new AutonomousGuard(defaultConfig);
    const state = createDefaultAgentAutonomousState();
    state.cooldownUntilMs = Date.now() - 1000; // expired

    const decision = guard.evaluate({
      nowMs: Date.now(),
      drawdownPct: 2,
      agentState: state,
    });

    expect(decision.allowTrading).toBe(true);
  });

  it('returns config via getConfig()', () => {
    const guard = new AutonomousGuard(defaultConfig);
    expect(guard.getConfig()).toEqual(defaultConfig);
  });
});
