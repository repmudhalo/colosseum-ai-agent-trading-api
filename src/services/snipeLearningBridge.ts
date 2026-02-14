/**
 * Snipe → Learning Bridge.
 *
 * Listens to snipe trade events and:
 *   1. Writes them into StateStore as ExecutionRecords
 *      so the existing learning, analytics, and trade history services
 *      can analyze snipe trades just like regular trades.
 *   2. Triggers periodic learning cycles to update knowledge base.
 *   3. Feeds learning insights back into the snipe service's strategy.
 *
 * This bridges the gap between the standalone snipe service
 * and the main execution pipeline.
 */

import { v4 as uuid } from 'uuid';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { AgentLearningService } from './agentLearningService.js';
import { SnipeService } from './snipeService.js';
import { ExecutionRecord } from '../types.js';

// Use a fixed "agent" ID for all snipe trades so the learning service
// can analyze them as a cohesive set of trades.
const SNIPE_AGENT_ID = 'snipe-bot';

// Run a learning cycle every N snipe trades.
const LEARNING_CYCLE_INTERVAL = 5;

// Minimum confidence to auto-apply strategy adjustments.
const MIN_CONFIDENCE_TO_APPLY = 0.6;

export class SnipeLearningBridge {
  private tradeCount = 0;
  private unsubscribers: (() => void)[] = [];

  constructor(
    private readonly store: StateStore,
    private readonly learningService: AgentLearningService,
    private readonly snipeService: SnipeService,
  ) {}

  /**
   * Start listening to snipe events.
   * Call once on startup (after all services are initialized).
   */
  start(): void {
    // Listen for all snipe trades (manual buys, sells, auto-exits, re-entries).
    const unsub1 = eventBus.on('snipe.trade', (_event, data) => {
      this.handleSnipeTrade(data as SnipeTradeEvent);
    });

    // Listen for auto-exits to trigger immediate learning.
    const unsub2 = eventBus.on('snipe.auto_exit', (_event, data) => {
      this.handleAutoExit(data as AutoExitEvent);
    });

    this.unsubscribers.push(unsub1, unsub2);

    // Ensure the snipe agent exists in the state store.
    this.ensureSnipeAgent();
  }

  /** Stop listening. */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  /**
   * Handle a snipe trade event:
   *   - Write an ExecutionRecord into StateStore
   *   - Trigger learning cycle every N trades
   */
  private async handleSnipeTrade(event: SnipeTradeEvent): Promise<void> {
    try {
      await this.writeExecutionRecord(event);
      this.tradeCount++;

      // Run learning cycle periodically.
      if (this.tradeCount % LEARNING_CYCLE_INTERVAL === 0) {
        this.runLearningCycle();
      }
    } catch {
      // Don't crash — learning is best-effort.
    }
  }

  /**
   * Handle auto-exit: run learning cycle immediately after a position closes.
   * This is the best time to learn — we have a complete trade (entry + exit).
   */
  private handleAutoExit(_event: AutoExitEvent): void {
    // Small delay so the execution record is written first.
    setTimeout(() => { this.runLearningCycle(); }, 200);
  }

  /**
   * Write a snipe trade as an ExecutionRecord in StateStore.
   * This makes snipe trades visible to all existing analytics services.
   */
  private async writeExecutionRecord(event: SnipeTradeEvent): Promise<void> {
    const executionId = `snipe_${event.tradeId}`;

    // Estimate USD values from the trade.
    // For buys: grossNotional ≈ amountSol * SOL price.
    // For sells: we use the realized P&L.
    const solPriceUsd = 200; // Rough estimate; could read from DexScreener later.
    const grossNotionalUsd = event.amountSol * solPriceUsd;

    const record: ExecutionRecord = {
      id: executionId,
      intentId: `snipe_intent_${event.tradeId}`,
      agentId: SNIPE_AGENT_ID,
      symbol: event.mintAddress.slice(0, 8).toUpperCase(), // Short symbol for display.
      side: event.side,
      quantity: Number(event.tokenAmount) || 0,
      priceUsd: event.entryPriceUsd ?? event.currentPriceUsd ?? 0,
      grossNotionalUsd,
      feeUsd: 0, // Jupiter fees are baked into the swap.
      netUsd: grossNotionalUsd,
      realizedPnlUsd: event.side === 'sell' ? (event.realizedPnlSol ?? 0) * solPriceUsd : 0,
      pnlSnapshotUsd: (event.realizedPnlSol ?? 0) * solPriceUsd,
      mode: event.simulated ? 'paper' : 'live',
      status: 'filled',
      txSignature: event.txSignature ?? undefined,
      createdAt: event.timestamp,
    };

    await this.store.transaction((state) => {
      state.executions[executionId] = record;

      // Also update price history for the token symbol.
      const symbol = record.symbol;
      if (!state.marketPriceHistoryUsd[symbol]) {
        state.marketPriceHistoryUsd[symbol] = [];
      }
      if (record.priceUsd > 0) {
        state.marketPriceHistoryUsd[symbol].push({
          priceUsd: record.priceUsd,
          ts: record.createdAt,
        });
        // Keep last 200 data points per symbol.
        if (state.marketPriceHistoryUsd[symbol].length > 200) {
          state.marketPriceHistoryUsd[symbol] =
            state.marketPriceHistoryUsd[symbol].slice(-200);
        }
      }

      // Update current market price.
      if (record.priceUsd > 0) {
        state.marketPricesUsd[symbol] = record.priceUsd;
      }
    });
  }

  /**
   * Run a learning cycle: analyze patterns, adapt parameters,
   * and optionally feed insights back into the snipe strategy.
   */
  private runLearningCycle(): void {
    try {
      // 1. Analyze trade patterns.
      const patterns = this.learningService.analyzePatterns(SNIPE_AGENT_ID);

      // 2. Adapt parameters based on recent performance.
      const adaptation = this.learningService.adaptParameters(SNIPE_AGENT_ID);

      // 3. Feed insights back: if the learning service suggests changes
      //    with high confidence, apply them to the snipe default strategy.
      this.applyLearningInsights(patterns.overallWinRate, adaptation);
    } catch {
      // Learning is best-effort.
    }
  }

  /**
   * Apply learning insights to the snipe service's default strategy.
   *
   * Rules:
   *   - If win rate is high (>60%), widen TP slightly.
   *   - If win rate is low (<35%), tighten SL.
   *   - If losing streak, reduce moon bag % to protect capital.
   *   - Only apply if confidence is above threshold.
   */
  private applyLearningInsights(winRate: number, adaptation: { adjustments: { parameter: string; newValue: number; confidenceLevel: number; reason: string }[] }): void {
    const highConfidenceAdjustments = adaptation.adjustments.filter(
      (a) => a.confidenceLevel >= MIN_CONFIDENCE_TO_APPLY,
    );

    if (highConfidenceAdjustments.length === 0) return;

    const currentStrategy = this.snipeService.getDefaultStrategy();
    const overrides: Record<string, number | null> = {};

    // If win rate is consistently high, widen TP to let winners run more.
    if (winRate > 0.6) {
      const newTp = Math.min(currentStrategy.takeProfitPct * 1.1, 100);
      overrides.takeProfitPct = Math.round(newTp);
    }

    // If win rate is low, tighten stop loss to cut losers faster.
    if (winRate < 0.35) {
      const newSl = Math.max(currentStrategy.stopLossPct * 0.85, 5);
      overrides.stopLossPct = Math.round(newSl);
    }

    // If cooldown suggestion increased (losing too often), reduce moon bag.
    const cooldownAdj = highConfidenceAdjustments.find((a) => a.parameter === 'cooldownSeconds');
    if (cooldownAdj && cooldownAdj.newValue > 10) {
      overrides.moonBagPct = Math.max(currentStrategy.moonBagPct - 5, 0);
    }

    if (Object.keys(overrides).length > 0) {
      this.snipeService.updateDefaultStrategy(overrides as Record<string, number>);
      eventBus.emit('snipe.strategy_updated', {
        source: 'learning',
        overrides,
        winRate,
        adjustmentCount: highConfidenceAdjustments.length,
      });
    }
  }

  /**
   * Ensure the virtual snipe agent exists in StateStore
   * so the learning service can query it.
   */
  private async ensureSnipeAgent(): Promise<void> {
    const state = this.store.snapshot();
    if (state.agents[SNIPE_AGENT_ID]) return;

    const now = new Date().toISOString();
    await this.store.transaction((s) => {
      s.agents[SNIPE_AGENT_ID] = {
        id: SNIPE_AGENT_ID,
        name: 'Snipe Bot',
        apiKey: 'snipe-internal',
        strategyId: 'momentum-v1', // Placeholder strategy ID.
        startingCapitalUsd: 0,
        cashUsd: 0,
        realizedPnlUsd: 0,
        positions: {},
        peakEquityUsd: 0,
        dailyRealizedPnlUsd: {},
        riskLimits: {
          maxPositionSizePct: 1,
          maxOrderNotionalUsd: 100000,
          maxGrossExposureUsd: 100000,
          dailyLossCapUsd: 100000,
          cooldownSeconds: 0,
          maxDrawdownPct: 1,
        },
        riskRejectionsByReason: {},
        createdAt: now,
        updatedAt: now,
      };
    });
  }
}

// ─── Event payload types ────────────────────────────────────────────────────

interface SnipeTradeEvent {
  tradeId: string;
  mintAddress: string;
  side: 'buy' | 'sell';
  amountSol: number;
  tokenAmount: string;
  txSignature: string | null;
  simulated: boolean;
  tag: string | null;
  autoExitReason: string | null;
  entryPriceUsd: number | null;
  currentPriceUsd: number | null;
  realizedPnlSol: number;
  status: string;
  timestamp: string;
}

interface AutoExitEvent {
  mintAddress: string;
  reason: string;
  isTakeProfit: boolean;
  keepMoonBag: boolean;
}
