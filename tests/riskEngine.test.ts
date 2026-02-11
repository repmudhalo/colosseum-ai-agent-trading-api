import { describe, expect, it } from 'vitest';
import { RiskEngine } from '../src/domain/risk/riskEngine.js';
import { Agent, TradeIntent } from '../src/types.js';

const baseAgent = (): Agent => ({
  id: 'agent-1',
  name: 'test',
  apiKey: 'k',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  startingCapitalUsd: 10_000,
  cashUsd: 10_000,
  realizedPnlUsd: 0,
  peakEquityUsd: 10_000,
  riskLimits: {
    maxPositionSizePct: 0.3,
    maxOrderNotionalUsd: 2_000,
    maxGrossExposureUsd: 5_000,
    dailyLossCapUsd: 500,
    maxDrawdownPct: 0.2,
    cooldownSeconds: 10,
  },
  positions: {},
  dailyRealizedPnlUsd: {},
  strategyId: 'momentum-v1',
  riskRejectionsByReason: {},
});

const baseIntent = (): TradeIntent => ({
  id: 'intent-1',
  agentId: 'agent-1',
  symbol: 'SOL',
  side: 'buy',
  notionalUsd: 100,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending',
});

describe('RiskEngine', () => {
  const risk = new RiskEngine();

  it('rejects orders above max order notional', () => {
    const agent = baseAgent();
    const intent = { ...baseIntent(), notionalUsd: 2_500 };
    const decision = risk.evaluate({ agent, intent, priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('max_order_notional_exceeded');
  });

  it('rejects if projected gross exposure exceeds cap', () => {
    const agent = baseAgent();
    agent.positions.SOL = {
      symbol: 'SOL',
      quantity: 40,
      avgEntryPriceUsd: 100,
    };

    const intent = { ...baseIntent(), notionalUsd: 1500 };
    const decision = risk.evaluate({ agent, intent, priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('gross_exposure_cap_exceeded');
  });

  it('rejects when daily loss cap was reached', () => {
    const agent = baseAgent();
    const today = new Date().toISOString().slice(0, 10);
    agent.dailyRealizedPnlUsd[today] = -600;

    const decision = risk.evaluate({ agent, intent: baseIntent(), priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('daily_loss_cap_reached');
  });

  it('rejects when drawdown guard is triggered', () => {
    const agent = baseAgent();
    agent.cashUsd = 7_900;

    const decision = risk.evaluate({ agent, intent: baseIntent(), priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('drawdown_guard_triggered');
  });

  it('rejects during cooldown', () => {
    const agent = baseAgent();
    agent.lastTradeAt = new Date(Date.now() - 1_000).toISOString();

    const decision = risk.evaluate({ agent, intent: baseIntent(), priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('cooldown_active');
  });

  it('approves valid intents', () => {
    const agent = baseAgent();
    const decision = risk.evaluate({ agent, intent: baseIntent(), priceUsd: 100, now: new Date() });
    expect(decision.approved).toBe(true);
    expect(decision.computedNotionalUsd).toBe(100);
  });
});
