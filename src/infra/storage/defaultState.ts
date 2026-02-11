import { AppState } from '../../types.js';
import { isoNow } from '../../utils/time.js';

export const createDefaultState = (): AppState => ({
  agents: {},
  tradeIntents: {},
  executions: {},
  treasury: {
    totalFeesUsd: 0,
    entries: [],
  },
  marketPricesUsd: {
    SOL: 100,
    USDC: 1,
    BONK: 0.00002,
    JUP: 0.8,
  },
  metrics: {
    startedAt: isoNow(),
    workerLoops: 0,
    intentsReceived: 0,
    intentsExecuted: 0,
    intentsRejected: 0,
    intentsFailed: 0,
    riskRejectionsByReason: {},
    apiPaymentDenials: 0,
  },
});
