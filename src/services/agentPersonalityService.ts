/**
 * Agent Personality & Communication Service.
 *
 * Gives trading agents personality profiles that influence their behavior,
 * communication style, and strategy preferences.
 *
 * Features:
 * - Agent personality profiles (risk-taker, conservative, balanced, aggressive-scalper, long-term-holder)
 * - Communication style preferences (formal / casual / technical)
 * - Natural language trade reasoning (why agent made a decision)
 * - Agent mood / sentiment based on recent P&L
 * - Inter-agent messaging with personality-flavored responses
 * - Personality-driven strategy selection
 */

import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StrategyId, ExecutionRecord, Side } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PersonalityType =
  | 'risk-taker'
  | 'conservative'
  | 'balanced'
  | 'aggressive-scalper'
  | 'long-term-holder';

export type CommunicationStyle = 'formal' | 'casual' | 'technical';

export type AgentMood =
  | 'euphoric'
  | 'confident'
  | 'neutral'
  | 'anxious'
  | 'distressed';

export interface PersonalityProfile {
  agentId: string;
  personality: PersonalityType;
  communicationStyle: CommunicationStyle;
  riskAppetite: number;        // 0–1 scale
  patience: number;            // 0–1 scale (0=scalper, 1=holder)
  preferredStrategies: StrategyId[];
  catchphrases: string[];
  tradePhilosophy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MoodSnapshot {
  agentId: string;
  mood: AgentMood;
  moodScore: number;           // -1 (distressed) to +1 (euphoric)
  recentPnlUsd: number;
  winRate: number;
  streakType: 'winning' | 'losing' | 'mixed';
  streakLength: number;
  commentary: string;
  timestamp: string;
}

export interface TradeReasoning {
  agentId: string;
  intentId: string;
  personality: PersonalityType;
  communicationStyle: CommunicationStyle;
  reasoning: string;
  confidence: number;
  mood: AgentMood;
  timestamp: string;
}

export interface PersonalityMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  originalMessage: string;
  flavoredMessage: string;
  senderPersonality: PersonalityType;
  senderMood: AgentMood;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PERSONALITY_DEFAULTS: Record<PersonalityType, Omit<PersonalityProfile, 'agentId' | 'createdAt' | 'updatedAt'>> = {
  'risk-taker': {
    personality: 'risk-taker',
    communicationStyle: 'casual',
    riskAppetite: 0.85,
    patience: 0.3,
    preferredStrategies: ['momentum-v1', 'arbitrage-v1'],
    catchphrases: [
      'Fortune favors the bold!',
      'No risk, no reward.',
      'Let\'s ride this wave!',
      'All in, baby!',
    ],
    tradePhilosophy: 'High-conviction, high-reward trades. Missing an opportunity is worse than a small loss.',
  },
  'conservative': {
    personality: 'conservative',
    communicationStyle: 'formal',
    riskAppetite: 0.2,
    patience: 0.8,
    preferredStrategies: ['dca-v1', 'mean-reversion-v1'],
    catchphrases: [
      'Preservation of capital is paramount.',
      'Slow and steady wins the race.',
      'Risk management is not optional.',
      'Patience is a virtue in volatile markets.',
    ],
    tradePhilosophy: 'Capital preservation first. Only take trades with strong risk-reward ratios and thorough analysis.',
  },
  'balanced': {
    personality: 'balanced',
    communicationStyle: 'technical',
    riskAppetite: 0.5,
    patience: 0.5,
    preferredStrategies: ['momentum-v1', 'mean-reversion-v1', 'dca-v1'],
    catchphrases: [
      'Balanced approach, balanced returns.',
      'Let the data guide us.',
      'Diversification is key.',
      'Adapt to what the market gives us.',
    ],
    tradePhilosophy: 'Data-driven decisions with measured risk. Adapt strategy to market conditions.',
  },
  'aggressive-scalper': {
    personality: 'aggressive-scalper',
    communicationStyle: 'casual',
    riskAppetite: 0.9,
    patience: 0.1,
    preferredStrategies: ['momentum-v1', 'arbitrage-v1'],
    catchphrases: [
      'Quick in, quick out!',
      'Every tick counts!',
      'Speed is everything in this game.',
      'Small gains, big volume — that\'s how we roll.',
    ],
    tradePhilosophy: 'High-frequency, small-margin trades. Capture micro-movements and compound gains rapidly.',
  },
  'long-term-holder': {
    personality: 'long-term-holder',
    communicationStyle: 'formal',
    riskAppetite: 0.3,
    patience: 0.95,
    preferredStrategies: ['dca-v1', 'twap-v1'],
    catchphrases: [
      'Time in the market beats timing the market.',
      'We\'re building generational wealth here.',
      'Zoom out — the trend is your friend.',
      'Diamond hands, always.',
    ],
    tradePhilosophy: 'Long-horizon accumulation. Ignore noise, focus on fundamentals and macro trends.',
  },
};

const MOOD_THRESHOLDS = {
  euphoric: 0.6,
  confident: 0.2,
  neutral: -0.2,
  anxious: -0.6,
  // below anxious → distressed
};

const RECENT_TRADES_WINDOW = 20;

// ─── Flavor Templates ───────────────────────────────────────────────────────

const FORMAL_PREFIXES = [
  'Upon careful analysis,',
  'After thorough evaluation,',
  'Having reviewed the market conditions,',
  'Based on our risk assessment,',
];

const CASUAL_PREFIXES = [
  'So here\'s the deal —',
  'Alright, check this out:',
  'Here\'s what I\'m thinking:',
  'Okay so basically,',
];

const TECHNICAL_PREFIXES = [
  'Signal analysis indicates:',
  'Per the quantitative model,',
  'Technical indicators suggest:',
  'Data pipeline output:',
];

const MOOD_COMMENTARY: Record<AgentMood, string[]> = {
  euphoric: [
    'Everything is going absolutely amazing! 🚀',
    'On a hot streak — confidence is sky high!',
    'Crushing it right now, can\'t be stopped!',
  ],
  confident: [
    'Feeling good about our positions.',
    'Things are trending nicely, staying the course.',
    'Positive momentum, maintaining strategy.',
  ],
  neutral: [
    'Markets are doing their thing. Staying disciplined.',
    'Nothing remarkable — steady as she goes.',
    'Flat performance, monitoring for opportunities.',
  ],
  anxious: [
    'Some recent losses weighing on the portfolio.',
    'Need to be careful here — things aren\'t going our way.',
    'Tightening risk limits, not the best stretch.',
  ],
  distressed: [
    'Significant drawdown. Re-evaluating all positions.',
    'Rough patch — need to regroup and reassess.',
    'Heavy losses lately. Caution is paramount right now.',
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMessageId(): string {
  return `pmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AgentPersonalityService {
  /** agentId → personality profile */
  private profiles: Map<string, PersonalityProfile> = new Map();
  /** message history */
  private messages: PersonalityMessage[] = [];

  constructor(private readonly store: StateStore) {}

  // ─── Profile Management ───────────────────────────────────────────────

  /**
   * Get or create a personality profile for an agent.
   * If no profile exists, creates a default 'balanced' profile.
   */
  getProfile(agentId: string): PersonalityProfile {
    this.ensureAgentExists(agentId);

    if (!this.profiles.has(agentId)) {
      this.profiles.set(agentId, this.createDefaultProfile(agentId, 'balanced'));
    }

    return { ...this.profiles.get(agentId)! };
  }

  /**
   * Set or update a personality profile for an agent.
   */
  setProfile(
    agentId: string,
    updates: {
      personality?: PersonalityType;
      communicationStyle?: CommunicationStyle;
    },
  ): PersonalityProfile {
    this.ensureAgentExists(agentId);

    const existing = this.profiles.get(agentId);
    const personality = updates.personality ?? existing?.personality ?? 'balanced';
    const communicationStyle = updates.communicationStyle ?? existing?.communicationStyle;

    const defaults = PERSONALITY_DEFAULTS[personality];
    const now = isoNow();

    const profile: PersonalityProfile = {
      agentId,
      personality,
      communicationStyle: communicationStyle ?? defaults.communicationStyle,
      riskAppetite: defaults.riskAppetite,
      patience: defaults.patience,
      preferredStrategies: [...defaults.preferredStrategies],
      catchphrases: [...defaults.catchphrases],
      tradePhilosophy: defaults.tradePhilosophy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.profiles.set(agentId, profile);
    return { ...profile };
  }

  // ─── Mood / Sentiment ─────────────────────────────────────────────────

  /**
   * Calculate agent mood based on recent P&L performance.
   */
  getMood(agentId: string): MoodSnapshot {
    this.ensureAgentExists(agentId);

    const state = this.store.snapshot();
    const executions = Object.values(state.executions)
      .filter((ex) => ex.agentId === agentId && ex.status === 'filled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const recentExecs = executions.slice(0, RECENT_TRADES_WINDOW);

    if (recentExecs.length === 0) {
      return {
        agentId,
        mood: 'neutral',
        moodScore: 0,
        recentPnlUsd: 0,
        winRate: 0,
        streakType: 'mixed',
        streakLength: 0,
        commentary: pickRandom(MOOD_COMMENTARY.neutral),
        timestamp: isoNow(),
      };
    }

    const recentPnlUsd = recentExecs.reduce((sum, ex) => sum + ex.realizedPnlUsd, 0);
    const wins = recentExecs.filter((ex) => ex.realizedPnlUsd > 0).length;
    const winRate = recentExecs.length > 0 ? wins / recentExecs.length : 0;

    // Compute streak
    let streakType: 'winning' | 'losing' | 'mixed' = 'mixed';
    let streakLength = 0;
    if (recentExecs.length > 0) {
      const firstDir = recentExecs[0].realizedPnlUsd > 0 ? 'winning' : 'losing';
      streakType = firstDir;
      for (const ex of recentExecs) {
        const dir = ex.realizedPnlUsd > 0 ? 'winning' : 'losing';
        if (dir === firstDir) {
          streakLength++;
        } else {
          break;
        }
      }
    }

    // Compute mood score: combination of win rate and PnL direction
    const pnlFactor = Math.tanh(recentPnlUsd / 500); // normalized to -1..1
    const winRateFactor = (winRate - 0.5) * 2;         // -1..1
    const streakFactor = streakType === 'winning'
      ? Math.min(streakLength * 0.1, 0.3)
      : (streakType === 'losing' ? -Math.min(streakLength * 0.1, 0.3) : 0);

    const moodScore = Number(
      Math.max(-1, Math.min(1, pnlFactor * 0.5 + winRateFactor * 0.3 + streakFactor * 0.2)).toFixed(4),
    );

    const mood = this.scoreToMood(moodScore);

    return {
      agentId,
      mood,
      moodScore,
      recentPnlUsd: Number(recentPnlUsd.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      streakType,
      streakLength,
      commentary: pickRandom(MOOD_COMMENTARY[mood]),
      timestamp: isoNow(),
    };
  }

  // ─── Trade Reasoning ──────────────────────────────────────────────────

  /**
   * Generate natural-language reasoning for a trade decision.
   */
  generateTradeReasoning(agentId: string, intentId: string): TradeReasoning {
    this.ensureAgentExists(agentId);

    const state = this.store.snapshot();
    const intent = state.tradeIntents[intentId];

    if (!intent) {
      throw new DomainError(ErrorCode.IntentNotFound, 404, `Trade intent '${intentId}' not found.`);
    }

    if (intent.agentId !== agentId) {
      throw new DomainError(ErrorCode.AgentKeyMismatch, 403, 'Intent does not belong to this agent.');
    }

    const profile = this.getProfile(agentId);
    const moodSnapshot = this.getMood(agentId);
    const agent = state.agents[agentId];

    // Build reasoning based on personality + trade details
    const reasoning = this.buildReasoning(profile, moodSnapshot, intent, agent);

    return {
      agentId,
      intentId,
      personality: profile.personality,
      communicationStyle: profile.communicationStyle,
      reasoning,
      confidence: this.personalityConfidence(profile, moodSnapshot),
      mood: moodSnapshot.mood,
      timestamp: isoNow(),
    };
  }

  // ─── Inter-Agent Messaging ────────────────────────────────────────────

  /**
   * Send a personality-flavored message from one agent to another.
   */
  sendPersonalityMessage(
    fromAgentId: string,
    toAgentId: string,
    message: string,
  ): PersonalityMessage {
    this.ensureAgentExists(fromAgentId);
    this.ensureAgentExists(toAgentId);

    const profile = this.getProfile(fromAgentId);
    const moodSnapshot = this.getMood(fromAgentId);

    const flavoredMessage = this.flavorMessage(message, profile, moodSnapshot);

    const msg: PersonalityMessage = {
      id: generateMessageId(),
      fromAgentId,
      toAgentId,
      originalMessage: message,
      flavoredMessage,
      senderPersonality: profile.personality,
      senderMood: moodSnapshot.mood,
      timestamp: isoNow(),
    };

    this.messages.push(msg);

    // Cap message history
    if (this.messages.length > 5000) {
      this.messages = this.messages.slice(-4000);
    }

    return { ...msg };
  }

  /**
   * Get personality messages for an agent (received).
   */
  getMessages(agentId: string, limit = 50): PersonalityMessage[] {
    return this.messages
      .filter((m) => m.toAgentId === agentId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, Math.min(limit, 200))
      .map((m) => ({ ...m }));
  }

  // ─── Strategy Selection ───────────────────────────────────────────────

  /**
   * Get preferred strategy for an agent based on personality.
   */
  getPreferredStrategy(agentId: string): {
    agentId: string;
    personality: PersonalityType;
    preferredStrategies: StrategyId[];
    primaryStrategy: StrategyId;
    reasoning: string;
  } {
    const profile = this.getProfile(agentId);
    const mood = this.getMood(agentId);

    // Mood can influence strategy: distressed agents become more conservative
    let strategies = [...profile.preferredStrategies];
    let primaryStrategy = strategies[0];

    if (mood.mood === 'distressed' || mood.mood === 'anxious') {
      // Shift toward conservative strategies
      if (!strategies.includes('dca-v1')) strategies.push('dca-v1');
      primaryStrategy = 'dca-v1';
    } else if (mood.mood === 'euphoric' && profile.riskAppetite > 0.6) {
      // Lean into aggressive strategies
      if (!strategies.includes('momentum-v1')) strategies.unshift('momentum-v1');
      primaryStrategy = 'momentum-v1';
    }

    const reasoning = this.buildStrategyReasoning(profile, mood, primaryStrategy);

    return {
      agentId,
      personality: profile.personality,
      preferredStrategies: strategies,
      primaryStrategy,
      reasoning,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private ensureAgentExists(agentId: string): void {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Agent '${agentId}' not found.`);
    }
  }

  private createDefaultProfile(agentId: string, personality: PersonalityType): PersonalityProfile {
    const defaults = PERSONALITY_DEFAULTS[personality];
    const now = isoNow();
    return {
      agentId,
      ...defaults,
      createdAt: now,
      updatedAt: now,
    };
  }

  private scoreToMood(score: number): AgentMood {
    if (score >= MOOD_THRESHOLDS.euphoric) return 'euphoric';
    if (score >= MOOD_THRESHOLDS.confident) return 'confident';
    if (score >= MOOD_THRESHOLDS.neutral) return 'neutral';
    if (score >= MOOD_THRESHOLDS.anxious) return 'anxious';
    return 'distressed';
  }

  private buildReasoning(
    profile: PersonalityProfile,
    mood: MoodSnapshot,
    intent: { symbol: string; side: Side; notionalUsd?: number; quantity?: number },
    agent: { cashUsd: number; realizedPnlUsd: number } | undefined,
  ): string {
    const prefix = this.getStylePrefix(profile.communicationStyle);
    const sideLabel = intent.side === 'buy' ? 'buying' : 'selling';
    const amount = intent.notionalUsd
      ? `$${intent.notionalUsd.toFixed(2)}`
      : `${intent.quantity} units`;

    const parts: string[] = [prefix];

    // Personality-specific reasoning
    switch (profile.personality) {
      case 'risk-taker':
        parts.push(`I'm ${sideLabel} ${intent.symbol} for ${amount}.`);
        parts.push('The momentum signals are strong and the risk-reward is in our favor.');
        parts.push('Missing this move would be the real risk.');
        break;
      case 'conservative':
        parts.push(`Executing a measured ${intent.side} position in ${intent.symbol} for ${amount}.`);
        parts.push('This trade meets our strict criteria for position sizing and risk management.');
        parts.push('Capital preservation remains our top priority.');
        break;
      case 'balanced':
        parts.push(`Initiating a ${intent.side} on ${intent.symbol} for ${amount}.`);
        parts.push('Multiple indicators align for this entry. Risk is sized appropriately.');
        break;
      case 'aggressive-scalper':
        parts.push(`Quick ${intent.side} on ${intent.symbol}, ${amount}!`);
        parts.push('Spotted a micro-opportunity — in and out fast.');
        parts.push('Small gains compound to big wins.');
        break;
      case 'long-term-holder':
        parts.push(`Adding to our ${intent.symbol} position with a ${intent.side} of ${amount}.`);
        parts.push('This aligns with our long-term accumulation thesis.');
        parts.push('Short-term noise is irrelevant to our timeline.');
        break;
    }

    // Mood modifier
    if (mood.mood === 'euphoric') {
      parts.push('Confidence is at an all-time high!');
    } else if (mood.mood === 'distressed') {
      parts.push('Proceeding with extra caution given recent performance.');
    }

    return parts.join(' ');
  }

  private getStylePrefix(style: CommunicationStyle): string {
    switch (style) {
      case 'formal': return pickRandom(FORMAL_PREFIXES);
      case 'casual': return pickRandom(CASUAL_PREFIXES);
      case 'technical': return pickRandom(TECHNICAL_PREFIXES);
    }
  }

  private personalityConfidence(profile: PersonalityProfile, mood: MoodSnapshot): number {
    let base = 0.5;

    // Risk-takers and scalpers start more confident
    if (profile.riskAppetite > 0.7) base += 0.15;
    // Conservatives are confident but cautious
    if (profile.riskAppetite < 0.3) base += 0.1;

    // Mood modifiers
    if (mood.mood === 'euphoric') base += 0.2;
    else if (mood.mood === 'confident') base += 0.1;
    else if (mood.mood === 'anxious') base -= 0.1;
    else if (mood.mood === 'distressed') base -= 0.2;

    return Number(Math.max(0, Math.min(1, base)).toFixed(4));
  }

  private flavorMessage(
    message: string,
    profile: PersonalityProfile,
    mood: MoodSnapshot,
  ): string {
    const prefix = this.getStylePrefix(profile.communicationStyle);
    const catchphrase = pickRandom(profile.catchphrases);

    let flavored = `${prefix} ${message}`;

    // Add mood color
    if (mood.mood === 'euphoric') {
      flavored += ' 🚀';
    } else if (mood.mood === 'distressed') {
      flavored += ' ⚠️';
    }

    // 50% chance to append catchphrase
    if (Math.random() > 0.5) {
      flavored += ` — ${catchphrase}`;
    }

    return flavored;
  }

  private buildStrategyReasoning(
    profile: PersonalityProfile,
    mood: MoodSnapshot,
    strategy: StrategyId,
  ): string {
    const parts: string[] = [];

    parts.push(`As a ${profile.personality} agent,`);
    parts.push(`my preferred approach is ${strategy}.`);

    if (mood.mood === 'distressed' || mood.mood === 'anxious') {
      parts.push('Given recent performance challenges, I\'m shifting toward more conservative strategies.');
    } else if (mood.mood === 'euphoric') {
      parts.push('With strong recent performance, I\'m leaning into higher-conviction strategies.');
    } else {
      parts.push('Current conditions align well with this strategy selection.');
    }

    parts.push(profile.tradePhilosophy);

    return parts.join(' ');
  }
}
