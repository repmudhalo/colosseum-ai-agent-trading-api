import Fastify from 'fastify';
import { registerRoutes } from './api/routes.js';
import { AppConfig } from './config.js';
import { FeeEngine } from './domain/fee/feeEngine.js';
import { StrategyRegistry } from './domain/strategy/strategyRegistry.js';
import { EventLogger } from './infra/logger.js';
import { StateStore } from './infra/storage/stateStore.js';
import { AgentService } from './services/agentService.js';
import { ExecutionService } from './services/executionService.js';
import { x402PaymentGate } from './services/paymentGate.js';
import { TradeIntentService } from './services/tradeIntentService.js';
import { ExecutionWorker } from './services/worker.js';
import { loadX402Policy } from './services/x402Policy.js';

export interface AppContext {
  app: ReturnType<typeof Fastify>;
  worker: ExecutionWorker;
  stateStore: StateStore;
  logger: EventLogger;
}

export async function buildApp(config: AppConfig): Promise<AppContext> {
  const app = Fastify({
    logger: false,
  });

  const stateStore = new StateStore(config.paths.stateFile);
  await stateStore.init();

  const logger = new EventLogger(config.paths.logFile);
  await logger.init();

  const strategyRegistry = new StrategyRegistry();
  const feeEngine = new FeeEngine(config.trading);
  const agentService = new AgentService(stateStore, config, strategyRegistry);
  const intentService = new TradeIntentService(stateStore);
  const executionService = new ExecutionService(stateStore, logger, feeEngine, config);

  const worker = new ExecutionWorker(
    stateStore,
    executionService,
    logger,
    config.worker.intervalMs,
    config.worker.maxBatchSize,
  );

  const x402Policy = await loadX402Policy(config.payments.x402PolicyFile, config.payments.x402RequiredPaths);
  app.addHook('preHandler', x402PaymentGate(config.payments, stateStore, x402Policy));

  const startedAt = Date.now();
  await registerRoutes(app, {
    config,
    store: stateStore,
    agentService,
    intentService,
    executionService,
    feeEngine,
    strategyRegistry,
    x402Policy,
    getRuntimeMetrics: () => {
      const state = stateStore.snapshot();
      return {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        pendingIntents: Object.values(state.tradeIntents).filter((intent) => intent.status === 'pending').length,
        processPid: process.pid,
      };
    },
  });

  return {
    app,
    worker,
    stateStore,
    logger,
  };
}
