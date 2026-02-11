import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { FeeEngine } from '../domain/fee/feeEngine.js';
import { RiskEngine } from '../domain/risk/riskEngine.js';
import { JupiterClient } from '../infra/live/jupiterClient.js';
import { EventLogger } from '../infra/logger.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { Agent, ExecutionMode, ExecutionRecord, TradeIntent } from '../types.js';
import { dayKey, isoNow } from '../utils/time.js';

const DECIMALS_BY_SYMBOL: Record<string, number> = {
  USDC: 6,
  SOL: 9,
  BONK: 5,
  JUP: 6,
};

export class ExecutionService {
  private readonly riskEngine = new RiskEngine();
  private readonly jupiterClient: JupiterClient;

  constructor(
    private readonly store: StateStore,
    private readonly logger: EventLogger,
    private readonly feeEngine: FeeEngine,
    private readonly config: AppConfig,
  ) {
    this.jupiterClient = new JupiterClient(
      config.trading.jupiterQuoteUrl,
      config.trading.jupiterSwapUrl,
      config.trading.solanaRpcUrl,
      config.trading.solanaPrivateKeyB58,
      config.trading.liveBroadcastEnabled,
    );
  }

  async setMarketPrice(symbol: string, priceUsd: number): Promise<void> {
    await this.store.transaction((state) => {
      state.marketPricesUsd[symbol.toUpperCase()] = Number(priceUsd.toFixed(8));
      return undefined;
    });
  }

  getMarketPrices(): Record<string, number> {
    return this.store.snapshot().marketPricesUsd;
  }

  async processIntent(intentId: string): Promise<void> {
    const claim = await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent || intent.status !== 'pending') return undefined;
      intent.status = 'processing';
      intent.updatedAt = isoNow();
      return { ...intent };
    });

    if (!claim) return;

    const snapshot = this.store.snapshot();
    const agent = snapshot.agents[claim.agentId];
    if (!agent) {
      await this.markIntentFailed(claim.id, 'unknown_agent');
      return;
    }

    const marketPrice = snapshot.marketPricesUsd[claim.symbol];
    if (!marketPrice) {
      await this.markIntentRejected(claim.id, 'market_price_missing');
      return;
    }

    const decision = this.riskEngine.evaluate({
      agent,
      intent: claim,
      priceUsd: marketPrice,
      now: new Date(),
    });

    if (!decision.approved) {
      await this.markIntentRejected(claim.id, decision.reason ?? 'risk_rejected');
      return;
    }

    const mode = this.resolveMode(claim);
    if (mode === 'live' && !this.canRunLiveMode()) {
      await this.markIntentRejected(claim.id, 'live_mode_not_configured');
      return;
    }

    const executionId = uuid();
    const executionBase = {
      id: executionId,
      intentId: claim.id,
      agentId: claim.agentId,
      symbol: claim.symbol,
      side: claim.side,
      quantity: decision.computedQuantity,
      priceUsd: marketPrice,
      grossNotionalUsd: decision.computedNotionalUsd,
      feeUsd: this.feeEngine.calculateExecutionFeeUsd(decision.computedNotionalUsd),
      mode,
      createdAt: isoNow(),
    } as const;

    if (mode === 'paper') {
      await this.applyPaperExecution(claim, agent, executionBase);
      return;
    }

    await this.applyLiveExecution(claim, agent, executionBase);
  }

  private async applyPaperExecution(
    intent: TradeIntent,
    _agent: Agent,
    executionBase: Omit<ExecutionRecord, 'status' | 'netUsd' | 'realizedPnlUsd'>,
  ): Promise<void> {
    await this.store.transaction((state) => {
      const agent = state.agents[intent.agentId];
      const trackedIntent = state.tradeIntents[intent.id];
      if (!agent || !trackedIntent) return undefined;

      const applyResult = this.applyAccountingTrade(agent, {
        symbol: executionBase.symbol,
        side: executionBase.side,
        quantity: executionBase.quantity,
        priceUsd: executionBase.priceUsd,
        feeUsd: executionBase.feeUsd,
      }, state.marketPricesUsd);

      if (!applyResult.ok) {
        const failed: ExecutionRecord = {
          ...executionBase,
          status: 'failed',
          failureReason: applyResult.reason,
          netUsd: 0,
          realizedPnlUsd: 0,
        };

        state.executions[failed.id] = failed;
        trackedIntent.status = 'failed';
        trackedIntent.statusReason = applyResult.reason;
        trackedIntent.executionId = failed.id;
        trackedIntent.updatedAt = isoNow();
        state.metrics.intentsFailed += 1;
        return undefined;
      }

      const execution: ExecutionRecord = {
        ...executionBase,
        status: 'filled',
        netUsd: applyResult.netUsd,
        realizedPnlUsd: applyResult.realizedPnlUsd,
      };

      state.executions[execution.id] = execution;
      trackedIntent.status = 'executed';
      trackedIntent.executionId = execution.id;
      trackedIntent.updatedAt = isoNow();

      state.treasury.totalFeesUsd = Number((state.treasury.totalFeesUsd + execution.feeUsd).toFixed(8));
      state.treasury.entries.unshift({
        id: uuid(),
        source: 'execution-fee',
        amountUsd: execution.feeUsd,
        refId: execution.id,
        createdAt: isoNow(),
        notes: 'paper execution fee',
      });

      state.metrics.intentsExecuted += 1;
      return undefined;
    });

    await this.logger.log('info', 'intent.executed.paper', {
      intentId: intent.id,
      agentId: intent.agentId,
      symbol: intent.symbol,
      side: intent.side,
    });
  }

  private async applyLiveExecution(
    intent: TradeIntent,
    _agent: Agent,
    executionBase: Omit<ExecutionRecord, 'status' | 'netUsd' | 'realizedPnlUsd'>,
  ): Promise<void> {
    const symbolMint = this.config.trading.symbolToMint[intent.symbol];
    const usdcMint = this.config.trading.symbolToMint.USDC;

    if (!symbolMint || !usdcMint) {
      await this.markIntentFailed(intent.id, 'mint_config_missing');
      return;
    }

    const isBuy = intent.side === 'buy';
    const feeParams = this.feeEngine.buildJupiterFeeParams();

    const quote = await this.jupiterClient.quote({
      inputMint: isBuy ? usdcMint : symbolMint,
      outputMint: isBuy ? symbolMint : usdcMint,
      amount: this.toChainAmount(
        isBuy ? 'USDC' : intent.symbol,
        executionBase.grossNotionalUsd / (isBuy ? 1 : executionBase.priceUsd),
      ),
      slippageBps: 50,
      platformFeeBps: feeParams.platformFeeBps,
    }).catch(async (error: unknown) => {
      await this.markIntentFailed(intent.id, `jupiter_quote_error:${String(error)}`);
      return undefined;
    });

    if (!quote) return;

    const swap = await this.jupiterClient.swapFromQuote(quote, feeParams.feeAccount).catch(async (error: unknown) => {
      await this.markIntentFailed(intent.id, `jupiter_swap_error:${String(error)}`);
      return undefined;
    });

    if (!swap) return;

    await this.store.transaction((state) => {
      const agent = state.agents[intent.agentId];
      const trackedIntent = state.tradeIntents[intent.id];
      if (!agent || !trackedIntent) return undefined;

      const applyResult = this.applyAccountingTrade(agent, {
        symbol: executionBase.symbol,
        side: executionBase.side,
        quantity: executionBase.quantity,
        priceUsd: executionBase.priceUsd,
        feeUsd: executionBase.feeUsd,
      }, state.marketPricesUsd);

      if (!applyResult.ok) {
        const failed: ExecutionRecord = {
          ...executionBase,
          status: 'failed',
          failureReason: applyResult.reason,
          netUsd: 0,
          realizedPnlUsd: 0,
        };

        state.executions[failed.id] = failed;
        trackedIntent.status = 'failed';
        trackedIntent.statusReason = applyResult.reason;
        trackedIntent.executionId = failed.id;
        trackedIntent.updatedAt = isoNow();
        state.metrics.intentsFailed += 1;
        return undefined;
      }

      const filled: ExecutionRecord = {
        ...executionBase,
        status: 'filled',
        netUsd: applyResult.netUsd,
        realizedPnlUsd: applyResult.realizedPnlUsd,
        txSignature: swap.txSignature,
      };

      state.executions[filled.id] = filled;
      trackedIntent.status = 'executed';
      trackedIntent.executionId = filled.id;
      trackedIntent.updatedAt = isoNow();

      state.treasury.totalFeesUsd = Number((state.treasury.totalFeesUsd + filled.feeUsd).toFixed(8));
      state.treasury.entries.unshift({
        id: uuid(),
        source: 'execution-fee',
        amountUsd: filled.feeUsd,
        refId: filled.id,
        createdAt: isoNow(),
        notes: swap.simulated ? 'live/simulated execution fee' : 'live on-chain execution fee',
      });

      state.metrics.intentsExecuted += 1;
      return undefined;
    });

    await this.logger.log('info', 'intent.executed.live', {
      intentId: intent.id,
      agentId: intent.agentId,
      simulated: swap.simulated,
      txSignature: swap.txSignature,
    });
  }

  private resolveMode(intent: TradeIntent): ExecutionMode {
    const requested = intent.requestedMode ?? this.config.trading.defaultMode;
    return requested === 'live' ? 'live' : 'paper';
  }

  private canRunLiveMode(): boolean {
    return this.config.trading.liveEnabled && this.jupiterClient.isReadyForLive();
  }

  private toChainAmount(symbol: string, units: number): number {
    const decimals = DECIMALS_BY_SYMBOL[symbol] ?? 6;
    return Math.floor(units * 10 ** decimals);
  }

  private applyAccountingTrade(
    agent: Agent,
    input: {
      symbol: string;
      side: 'buy' | 'sell';
      quantity: number;
      priceUsd: number;
      feeUsd: number;
    },
    market: Record<string, number>,
  ):
    | { ok: true; netUsd: number; realizedPnlUsd: number }
    | { ok: false; reason: string } {
    const gross = Number((input.quantity * input.priceUsd).toFixed(8));

    if (input.side === 'buy') {
      const totalCost = Number((gross + input.feeUsd).toFixed(8));
      if (agent.cashUsd < totalCost) {
        return { ok: false, reason: 'insufficient_cash_for_buy' };
      }

      const existing = agent.positions[input.symbol] ?? {
        symbol: input.symbol,
        quantity: 0,
        avgEntryPriceUsd: input.priceUsd,
      };

      const newQty = Number((existing.quantity + input.quantity).toFixed(8));
      const newAvg = Number((((existing.quantity * existing.avgEntryPriceUsd) + gross) / newQty).toFixed(8));

      agent.positions[input.symbol] = {
        symbol: input.symbol,
        quantity: newQty,
        avgEntryPriceUsd: newAvg,
      };

      agent.cashUsd = Number((agent.cashUsd - totalCost).toFixed(8));
      agent.updatedAt = isoNow();
      agent.lastTradeAt = isoNow();
      this.refreshEquity(agent, market);

      return {
        ok: true,
        netUsd: Number((-totalCost).toFixed(8)),
        realizedPnlUsd: 0,
      };
    }

    const existing = agent.positions[input.symbol];
    if (!existing || existing.quantity < input.quantity) {
      return { ok: false, reason: 'insufficient_inventory_for_sell' };
    }

    const proceeds = Number((gross - input.feeUsd).toFixed(8));
    const realizedPnl = Number(((input.priceUsd - existing.avgEntryPriceUsd) * input.quantity).toFixed(8));

    agent.cashUsd = Number((agent.cashUsd + proceeds).toFixed(8));
    agent.realizedPnlUsd = Number((agent.realizedPnlUsd + realizedPnl).toFixed(8));

    const remainingQty = Number((existing.quantity - input.quantity).toFixed(8));
    if (remainingQty <= 0) {
      delete agent.positions[input.symbol];
    } else {
      agent.positions[input.symbol] = {
        ...existing,
        quantity: remainingQty,
      };
    }

    const key = dayKey();
    agent.dailyRealizedPnlUsd[key] = Number(((agent.dailyRealizedPnlUsd[key] ?? 0) + realizedPnl).toFixed(8));
    agent.updatedAt = isoNow();
    agent.lastTradeAt = isoNow();
    this.refreshEquity(agent, market);

    return {
      ok: true,
      netUsd: proceeds,
      realizedPnlUsd: realizedPnl,
    };
  }

  private refreshEquity(agent: Agent, market: Record<string, number>): void {
    const equity = this.riskEngine.computeEquityUsd(agent, (symbol) => market[symbol]);
    agent.peakEquityUsd = Math.max(agent.peakEquityUsd, equity);
  }

  private async markIntentRejected(intentId: string, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent) return undefined;
      intent.status = 'rejected';
      intent.statusReason = reason;
      intent.updatedAt = isoNow();
      state.metrics.intentsRejected += 1;
      state.metrics.riskRejectionsByReason[reason] = (state.metrics.riskRejectionsByReason[reason] ?? 0) + 1;
      return undefined;
    });

    await this.logger.log('warn', 'intent.rejected', { intentId, reason });
  }

  private async markIntentFailed(intentId: string, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const intent = state.tradeIntents[intentId];
      if (!intent) return undefined;
      intent.status = 'failed';
      intent.statusReason = reason;
      intent.updatedAt = isoNow();
      state.metrics.intentsFailed += 1;
      return undefined;
    });

    await this.logger.log('error', 'intent.failed', { intentId, reason });
  }
}
