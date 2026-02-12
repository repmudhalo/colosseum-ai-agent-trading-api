import { describe, expect, it, beforeEach } from 'vitest';
import {
  AgentPersonalityService,
  PersonalityType,
  CommunicationStyle,
  AgentMood,
} from '../src/services/agentPersonalityService.js';
import { AppState, Agent, ExecutionRecord, TradeIntent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';
import { vi } from 'vitest';

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

function makeExecution(id: string, agentId: string, overrides?: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    id,
    intentId: `intent-${id}`,
    agentId,
    symbol: 'SOL',
    side: 'buy',
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 1,
    netUsd: 999,
    realizedPnlUsd: 50,
    pnlSnapshotUsd: 50,
    mode: 'paper',
    status: 'filled',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeIntent(id: string, agentId: string, overrides?: Partial<TradeIntent>): TradeIntent {
  return {
    id,
    agentId,
    symbol: 'SOL',
    side: 'buy',
    notionalUsd: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'executed',
    ...overrides,
  };
}

describe('AgentPersonalityService', () => {
  let service: AgentPersonalityService;
  let state: AppState;

  beforeEach(() => {
    state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'Alpha Bot');
    state.agents['agent-2'] = makeAgent('agent-2', 'Beta Bot');
    const store = createMockStore(state);
    service = new AgentPersonalityService(store);
  });

  // ─── Profile Management ──────────────────────────────────────────

  it('returns a default balanced profile for an agent with no profile set', () => {
    const profile = service.getProfile('agent-1');
    expect(profile.agentId).toBe('agent-1');
    expect(profile.personality).toBe('balanced');
    expect(profile.communicationStyle).toBe('technical');
    expect(profile.riskAppetite).toBe(0.5);
    expect(profile.patience).toBe(0.5);
    expect(profile.preferredStrategies).toContain('momentum-v1');
    expect(profile.catchphrases.length).toBeGreaterThan(0);
    expect(profile.tradePhilosophy).toBeTruthy();
    expect(profile.createdAt).toBeTruthy();
    expect(profile.updatedAt).toBeTruthy();
  });

  it('sets a risk-taker personality with correct attributes', () => {
    const profile = service.setProfile('agent-1', { personality: 'risk-taker' });
    expect(profile.personality).toBe('risk-taker');
    expect(profile.riskAppetite).toBe(0.85);
    expect(profile.patience).toBe(0.3);
    expect(profile.preferredStrategies).toContain('momentum-v1');
    expect(profile.preferredStrategies).toContain('arbitrage-v1');
  });

  it('sets a conservative personality with formal communication', () => {
    const profile = service.setProfile('agent-1', { personality: 'conservative' });
    expect(profile.personality).toBe('conservative');
    expect(profile.communicationStyle).toBe('formal');
    expect(profile.riskAppetite).toBe(0.2);
    expect(profile.patience).toBe(0.8);
    expect(profile.preferredStrategies).toContain('dca-v1');
  });

  it('allows overriding communication style independently', () => {
    service.setProfile('agent-1', { personality: 'risk-taker' });
    const updated = service.setProfile('agent-1', { communicationStyle: 'technical' });
    expect(updated.personality).toBe('risk-taker');
    expect(updated.communicationStyle).toBe('technical');
  });

  it('sets all five personality types correctly', () => {
    const types: PersonalityType[] = [
      'risk-taker', 'conservative', 'balanced', 'aggressive-scalper', 'long-term-holder',
    ];

    for (const t of types) {
      const profile = service.setProfile('agent-1', { personality: t });
      expect(profile.personality).toBe(t);
      expect(profile.riskAppetite).toBeGreaterThanOrEqual(0);
      expect(profile.riskAppetite).toBeLessThanOrEqual(1);
      expect(profile.patience).toBeGreaterThanOrEqual(0);
      expect(profile.patience).toBeLessThanOrEqual(1);
      expect(profile.preferredStrategies.length).toBeGreaterThan(0);
    }
  });

  it('throws AgentNotFound for a nonexistent agent', () => {
    expect(() => service.getProfile('nonexistent')).toThrow(/not found/i);
  });

  // ─── Mood / Sentiment ────────────────────────────────────────────

  it('returns neutral mood when agent has no trades', () => {
    const mood = service.getMood('agent-1');
    expect(mood.agentId).toBe('agent-1');
    expect(mood.mood).toBe('neutral');
    expect(mood.moodScore).toBe(0);
    expect(mood.recentPnlUsd).toBe(0);
    expect(mood.winRate).toBe(0);
    expect(mood.commentary).toBeTruthy();
    expect(mood.timestamp).toBeTruthy();
  });

  it('returns positive mood when agent has winning trades', () => {
    // Add winning executions
    for (let i = 0; i < 10; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: 100 + i * 10,
      });
    }

    const mood = service.getMood('agent-1');
    expect(mood.moodScore).toBeGreaterThan(0);
    expect(['euphoric', 'confident']).toContain(mood.mood);
    expect(mood.recentPnlUsd).toBeGreaterThan(0);
    expect(mood.winRate).toBe(1);
    expect(mood.streakType).toBe('winning');
    expect(mood.streakLength).toBe(10);
  });

  it('returns negative mood when agent has losing trades', () => {
    for (let i = 0; i < 10; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: -100 - i * 10,
      });
    }

    const mood = service.getMood('agent-1');
    expect(mood.moodScore).toBeLessThan(0);
    expect(['anxious', 'distressed']).toContain(mood.mood);
    expect(mood.recentPnlUsd).toBeLessThan(0);
    expect(mood.winRate).toBe(0);
    expect(mood.streakType).toBe('losing');
  });

  // ─── Trade Reasoning ─────────────────────────────────────────────

  it('generates trade reasoning with personality flavor', () => {
    state.tradeIntents['intent-1'] = makeIntent('intent-1', 'agent-1');
    service.setProfile('agent-1', { personality: 'risk-taker' });

    const reasoning = service.generateTradeReasoning('agent-1', 'intent-1');
    expect(reasoning.agentId).toBe('agent-1');
    expect(reasoning.intentId).toBe('intent-1');
    expect(reasoning.personality).toBe('risk-taker');
    expect(reasoning.reasoning).toBeTruthy();
    expect(reasoning.reasoning.length).toBeGreaterThan(20);
    expect(reasoning.confidence).toBeGreaterThan(0);
    expect(reasoning.confidence).toBeLessThanOrEqual(1);
    expect(reasoning.mood).toBeTruthy();
    expect(reasoning.timestamp).toBeTruthy();
  });

  it('throws IntentNotFound for invalid intent', () => {
    expect(() => service.generateTradeReasoning('agent-1', 'nonexistent')).toThrow(/not found/i);
  });

  it('throws when intent does not belong to agent', () => {
    state.tradeIntents['intent-1'] = makeIntent('intent-1', 'agent-2');
    expect(() => service.generateTradeReasoning('agent-1', 'intent-1')).toThrow(/does not belong/i);
  });

  // ─── Inter-Agent Messaging ────────────────────────────────────────

  it('sends a personality-flavored message between agents', () => {
    service.setProfile('agent-1', { personality: 'aggressive-scalper' });

    const msg = service.sendPersonalityMessage('agent-1', 'agent-2', 'SOL is pumping, buy now!');
    expect(msg.id).toBeTruthy();
    expect(msg.fromAgentId).toBe('agent-1');
    expect(msg.toAgentId).toBe('agent-2');
    expect(msg.originalMessage).toBe('SOL is pumping, buy now!');
    expect(msg.flavoredMessage).toBeTruthy();
    expect(msg.flavoredMessage.length).toBeGreaterThan(msg.originalMessage.length);
    expect(msg.senderPersonality).toBe('aggressive-scalper');
    expect(msg.timestamp).toBeTruthy();
  });

  it('retrieves personality messages for an agent', () => {
    service.sendPersonalityMessage('agent-1', 'agent-2', 'Message 1');
    service.sendPersonalityMessage('agent-1', 'agent-2', 'Message 2');
    service.sendPersonalityMessage('agent-2', 'agent-1', 'Reply');

    const messagesForAgent2 = service.getMessages('agent-2');
    expect(messagesForAgent2.length).toBe(2);
    const agent2OrigMessages = messagesForAgent2.map((m) => m.originalMessage).sort();
    expect(agent2OrigMessages).toEqual(['Message 1', 'Message 2']);

    const messagesForAgent1 = service.getMessages('agent-1');
    expect(messagesForAgent1.length).toBe(1);
    expect(messagesForAgent1[0].originalMessage).toBe('Reply');
  });

  // ─── Strategy Selection ──────────────────────────────────────────

  it('returns personality-driven strategy selection', () => {
    service.setProfile('agent-1', { personality: 'long-term-holder' });

    const selection = service.getPreferredStrategy('agent-1');
    expect(selection.agentId).toBe('agent-1');
    expect(selection.personality).toBe('long-term-holder');
    expect(selection.preferredStrategies).toContain('dca-v1');
    expect(selection.preferredStrategies).toContain('twap-v1');
    expect(selection.primaryStrategy).toBeTruthy();
    expect(selection.reasoning).toBeTruthy();
    expect(selection.reasoning.length).toBeGreaterThan(20);
  });

  it('shifts strategy toward conservative when mood is distressed', () => {
    // Give agent heavy losses
    for (let i = 0; i < 15; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: -200 - i * 50,
      });
    }
    service.setProfile('agent-1', { personality: 'risk-taker' });

    const selection = service.getPreferredStrategy('agent-1');
    expect(selection.preferredStrategies).toContain('dca-v1');
    expect(selection.primaryStrategy).toBe('dca-v1');
    expect(selection.reasoning).toContain('conservative');
  });

  // ─── Communication Style Variants ─────────────────────────────────

  it('formal communication uses formal prefixes in reasoning', () => {
    state.tradeIntents['intent-1'] = makeIntent('intent-1', 'agent-1');
    service.setProfile('agent-1', { personality: 'conservative', communicationStyle: 'formal' });

    const reasoning = service.generateTradeReasoning('agent-1', 'intent-1');
    // Formal prefixes include words like "analysis", "evaluation", "assessment"
    const formalWords = ['analysis', 'evaluation', 'conditions', 'assessment'];
    const hasFormality = formalWords.some((w) => reasoning.reasoning.toLowerCase().includes(w));
    expect(hasFormality).toBe(true);
  });

  // ─── Edge Cases ────────────────────────────────────────────────────

  it('handles getPreferredStrategy for euphoric high-risk agent', () => {
    // Give agent strong wins
    for (let i = 0; i < 10; i++) {
      state.executions[`ex-${i}`] = makeExecution(`ex-${i}`, 'agent-1', {
        realizedPnlUsd: 500 + i * 50,
      });
    }
    service.setProfile('agent-1', { personality: 'risk-taker' });

    const selection = service.getPreferredStrategy('agent-1');
    expect(selection.preferredStrategies[0]).toBe('momentum-v1');
    expect(selection.primaryStrategy).toBe('momentum-v1');
  });

  it('preserves createdAt timestamp when updating profile', () => {
    const initial = service.setProfile('agent-1', { personality: 'balanced' });
    const createdAt = initial.createdAt;

    // Update personality
    const updated = service.setProfile('agent-1', { personality: 'risk-taker' });
    expect(updated.createdAt).toBe(createdAt);
    expect(updated.updatedAt).toBeTruthy();
  });

  it('personality message limit is respected', () => {
    const msgs = service.getMessages('agent-2', 2);
    // Should return at most 2 even if there are more
    service.sendPersonalityMessage('agent-1', 'agent-2', 'M1');
    service.sendPersonalityMessage('agent-1', 'agent-2', 'M2');
    service.sendPersonalityMessage('agent-1', 'agent-2', 'M3');

    const limited = service.getMessages('agent-2', 2);
    expect(limited.length).toBe(2);
  });

  it('aggressive-scalper has highest risk appetite and lowest patience', () => {
    const profile = service.setProfile('agent-1', { personality: 'aggressive-scalper' });
    expect(profile.riskAppetite).toBe(0.9);
    expect(profile.patience).toBe(0.1);
  });
});
