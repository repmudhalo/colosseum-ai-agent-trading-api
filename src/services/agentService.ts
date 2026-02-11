import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { defaultRiskLimits } from '../domain/risk/defaults.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { Agent, RiskLimits } from '../types.js';
import { isoNow } from '../utils/time.js';

export interface RegisterAgentInput {
  name: string;
  startingCapitalUsd?: number;
  riskOverrides?: Partial<RiskLimits>;
}

export class AgentService {
  constructor(
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  async register(input: RegisterAgentInput): Promise<Agent> {
    const now = isoNow();
    const id = uuid();

    const defaults = defaultRiskLimits(this.config.risk);
    const mergedRisk: RiskLimits = {
      ...defaults,
      ...input.riskOverrides,
    };

    const startCapital = input.startingCapitalUsd ?? this.config.trading.defaultStartingCapitalUsd;

    const agent: Agent = {
      id,
      name: input.name,
      apiKey: crypto.randomBytes(24).toString('hex'),
      createdAt: now,
      updatedAt: now,
      startingCapitalUsd: startCapital,
      cashUsd: startCapital,
      realizedPnlUsd: 0,
      peakEquityUsd: startCapital,
      riskLimits: mergedRisk,
      positions: {},
      dailyRealizedPnlUsd: {},
    };

    await this.store.transaction((state) => {
      state.agents[id] = agent;
      return undefined;
    });

    return agent;
  }

  getById(agentId: string): Agent | undefined {
    return this.store.snapshot().agents[agentId];
  }

  findByApiKey(apiKey: string): Agent | undefined {
    const agents = Object.values(this.store.snapshot().agents);
    return agents.find((agent) => agent.apiKey === apiKey);
  }
}
