import Fastify from 'fastify';
import { AppConfig } from './config.js';
import { registerRoutes } from './api/routes.js';
import { FeeEngine } from './domain/fee/feeEngine.js';
import { EventLogger } from './infra/logger.js';
import { StateStore } from './infra/storage/stateStore.js';
import { AgentService } from './services/agentService.js';
import { ExecutionService } from './services/executionService.js';
import { x402PaymentGate } from './services/paymentGate.js';
import { TradeIntentService } from './services/tradeIntentService.js';
import { ExecutionWorker } from './services/worker.js';

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

  const feeEngine = new FeeEngine(config.trading);
  const agentService = new AgentService(stateStore, config);
  const intentService = new TradeIntentService(stateStore);
  const executionService = new ExecutionService(stateStore, logger, feeEngine, config);

  const worker = new ExecutionWorker(
    stateStore,
    executionService,
    logger,
    config.worker.intervalMs,
    config.worker.maxBatchSize,
  );

  app.addHook('preHandler', x402PaymentGate(config.payments, stateStore));

  const startedAt = Date.now();
  await registerRoutes(app, {
    config,
    store: stateStore,
    agentService,
    intentService,
    executionService,
    feeEngine,
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
