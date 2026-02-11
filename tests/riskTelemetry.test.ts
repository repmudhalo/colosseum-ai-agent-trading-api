import { describe, expect, it } from 'vitest';
import { FeeEngine } from '../src/domain/fee/feeEngine.js';
import { EventLogger } from '../src/infra/logger.js';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { ExecutionService } from '../src/services/executionService.js';
import { Agent } from '../src/types.js';
import { dayKey } from '../src/utils/time.js';
import { buildTestConfig, createTempDir } from './helpers.js';

const sampleAgent = (): Agent => ({
  id: 'agent-risk-1',
  name: 'risk-agent',
  apiKey: 'risk-key',
  createdAt: '2026-02-11T00:00:00.000Z',
  updatedAt: '2026-02-11T00:00:00.000Z',
  startingCapitalUsd: 10_000,
  cashUsd: 9_000,
  realizedPnlUsd: -250,
  peakEquityUsd: 10_000,
  riskLimits: {
    maxPositionSizePct: 0.25,
    maxOrderNotionalUsd: 2_500,
    maxGrossExposureUsd: 7_500,
    dailyLossCapUsd: 1_000,
    maxDrawdownPct: 0.2,
    cooldownSeconds: 10,
  },
  positions: {
    SOL: {
      symbol: 'SOL',
      quantity: 5,
      avgEntryPriceUsd: 120,
    },
  },
  dailyRealizedPnlUsd: {
    [dayKey()]: -120,
  },
  strategyId: 'momentum-v1',
  riskRejectionsByReason: {
    cooldown_active: 2,
    max_order_notional_exceeded: 1,
  },
  lastTradeAt: new Date(Date.now() - 1_500).toISOString(),
});

describe('ExecutionService risk telemetry', () => {
  it('computes drawdown, exposure, daily pnl, rejects and cooldown status', async () => {
    const tmpDir = await createTempDir();
    const cfg = buildTestConfig(tmpDir);

    const store = new StateStore(cfg.paths.stateFile);
    await store.init();

    await store.transaction((state) => {
      state.agents['agent-risk-1'] = sampleAgent();
      state.marketPricesUsd.SOL = 100;
      return undefined;
    });

    const service = new ExecutionService(
      store,
      new EventLogger(cfg.paths.logFile),
      new FeeEngine(cfg.trading),
      cfg,
    );

    const telemetry = service.getRiskTelemetry('agent-risk-1');
    expect(telemetry).toBeDefined();

    expect(telemetry?.grossExposureUsd).toBe(500);
    expect(telemetry?.equityUsd).toBe(9_500);
    expect(telemetry?.drawdownPct).toBe(0.05);
    expect(telemetry?.dailyPnlUsd).toBe(-120);
    expect(telemetry?.rejectCountersByReason.cooldown_active).toBe(2);
    expect(telemetry?.cooldown.active).toBe(true);
    expect(telemetry?.cooldown.remainingSeconds).toBeGreaterThan(0);
    expect(telemetry?.cooldown.cooldownSeconds).toBe(10);
  });
});
