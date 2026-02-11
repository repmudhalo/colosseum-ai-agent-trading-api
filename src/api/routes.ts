import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../config.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { AgentService } from '../services/agentService.js';
import { resolveAgentFromKey } from '../services/auth.js';
import { ExecutionService } from '../services/executionService.js';
import { TradeIntentService } from '../services/tradeIntentService.js';
import { RuntimeMetrics } from '../types.js';

interface RouteDeps {
  config: AppConfig;
  store: StateStore;
  agentService: AgentService;
  intentService: TradeIntentService;
  executionService: ExecutionService;
  feeEngine: FeeEngine;
  getRuntimeMetrics: () => RuntimeMetrics;
}

const registerAgentSchema = z.object({
  name: z.string().min(2).max(120),
  startingCapitalUsd: z.number().positive().optional(),
  riskOverrides: z.object({
    maxPositionSizePct: z.number().positive().max(1).optional(),
    maxOrderNotionalUsd: z.number().positive().optional(),
    maxGrossExposureUsd: z.number().positive().optional(),
    dailyLossCapUsd: z.number().positive().optional(),
    maxDrawdownPct: z.number().positive().max(1).optional(),
    cooldownSeconds: z.number().nonnegative().optional(),
  }).partial().optional(),
});

const tradeIntentSchema = z.object({
  agentId: z.string().min(2),
  symbol: z.string().min(2).max(20),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive().optional(),
  notionalUsd: z.number().positive().optional(),
  requestedMode: z.enum(['paper', 'live']).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).refine((payload) => payload.quantity || payload.notionalUsd, {
  message: 'quantity or notionalUsd required',
});

const marketUpdateSchema = z.object({
  symbol: z.string().min(2).max(20),
  priceUsd: z.number().positive(),
});

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/', async () => ({
    name: deps.config.app.name,
    version: '0.1.0',
    status: 'ok',
    mode: deps.config.trading.defaultMode,
  }));

  app.post('/agents/register', async (request, reply) => {
    const parse = registerAgentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parse.error.flatten() });
    }

    const agent = await deps.agentService.register(parse.data);

    return reply.code(201).send({
      agent: {
        id: agent.id,
        name: agent.name,
        createdAt: agent.createdAt,
        startingCapitalUsd: agent.startingCapitalUsd,
        riskLimits: agent.riskLimits,
      },
      apiKey: agent.apiKey,
      note: 'Store apiKey securely. It is required for trade-intent API access.',
    });
  });

  app.get('/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = deps.agentService.getById(agentId);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });

    return {
      id: agent.id,
      name: agent.name,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      startingCapitalUsd: agent.startingCapitalUsd,
      cashUsd: agent.cashUsd,
      realizedPnlUsd: agent.realizedPnlUsd,
      peakEquityUsd: agent.peakEquityUsd,
      riskLimits: agent.riskLimits,
      positions: Object.values(agent.positions),
      lastTradeAt: agent.lastTradeAt,
    };
  });

  app.get('/agents/:agentId/portfolio', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const state = deps.store.snapshot();
    const agent = state.agents[agentId];
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });

    const markedValue = Object.values(agent.positions).reduce((sum, position) => {
      const px = state.marketPricesUsd[position.symbol] ?? position.avgEntryPriceUsd;
      return sum + (position.quantity * px);
    }, 0);

    return {
      agentId,
      cashUsd: agent.cashUsd,
      inventoryValueUsd: Number(markedValue.toFixed(8)),
      equityUsd: Number((agent.cashUsd + markedValue).toFixed(8)),
      realizedPnlUsd: agent.realizedPnlUsd,
      positions: Object.values(agent.positions),
      marketPricesUsd: state.marketPricesUsd,
    };
  });

  app.post('/trade-intents', async (request, reply) => {
    const auth = resolveAgentFromKey(request, reply, deps.agentService);
    if (!auth) return;

    const parse = tradeIntentSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parse.error.flatten() });
    }

    if (auth.id !== parse.data.agentId) {
      return reply.code(403).send({ error: 'agent_key_mismatch' });
    }

    const symbol = parse.data.symbol.toUpperCase();
    if (!deps.config.trading.supportedSymbols.includes(symbol)) {
      return reply.code(400).send({
        error: 'unsupported_symbol',
        supportedSymbols: deps.config.trading.supportedSymbols,
      });
    }

    const intent = await deps.intentService.create({
      ...parse.data,
      symbol,
    });

    return reply.code(202).send({
      message: 'intent_queued',
      intent,
    });
  });

  app.get('/trade-intents/:intentId', async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const intent = deps.intentService.getById(intentId);
    if (!intent) return reply.code(404).send({ error: 'intent_not_found' });
    return intent;
  });

  app.get('/executions', async (request) => {
    const query = request.query as { agentId?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);

    const executions = Object.values(deps.store.snapshot().executions)
      .filter((ex) => (query.agentId ? ex.agentId === query.agentId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    return {
      executions,
    };
  });

  app.post('/market/prices', async (request, reply) => {
    const parse = marketUpdateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parse.error.flatten() });
    }

    await deps.executionService.setMarketPrice(parse.data.symbol.toUpperCase(), parse.data.priceUsd);

    return {
      ok: true,
      marketPricesUsd: deps.executionService.getMarketPrices(),
    };
  });

  app.get('/health', async () => {
    const state = deps.store.snapshot();
    const runtime = deps.getRuntimeMetrics();

    return {
      status: 'ok',
      env: deps.config.app.env,
      uptimeSeconds: runtime.uptimeSeconds,
      pendingIntents: runtime.pendingIntents,
      processPid: runtime.processPid,
      defaultMode: deps.config.trading.defaultMode,
      liveModeEnabled: deps.config.trading.liveEnabled,
      stateSummary: {
        agents: Object.keys(state.agents).length,
        intents: Object.keys(state.tradeIntents).length,
        executions: Object.keys(state.executions).length,
      },
    };
  });

  app.get('/metrics', async () => {
    const state = deps.store.snapshot();
    const runtime = deps.getRuntimeMetrics();

    return {
      runtime,
      metrics: state.metrics,
      treasury: state.treasury,
      monetization: deps.feeEngine.describeMonetizationModel(),
    };
  });

  app.get('/state', async () => deps.store.snapshot());
}
