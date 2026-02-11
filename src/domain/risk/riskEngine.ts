import { Agent, RiskDecision, TradeIntent } from '../../types.js';
import { dayKey } from '../../utils/time.js';

export interface RiskEvaluationInput {
  agent: Agent;
  intent: TradeIntent;
  priceUsd: number;
  now: Date;
}

const clamp = (v: number): number => Number(v.toFixed(8));

export class RiskEngine {
  evaluate(input: RiskEvaluationInput): RiskDecision {
    const { agent, intent, priceUsd, now } = input;

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      return {
        approved: false,
        reason: 'invalid_price',
        computedNotionalUsd: 0,
        computedQuantity: 0,
      };
    }

    const desiredNotional = intent.notionalUsd ?? ((intent.quantity ?? 0) * priceUsd);
    const desiredQuantity = intent.quantity ?? (intent.notionalUsd ? intent.notionalUsd / priceUsd : 0);

    if (desiredNotional <= 0 || desiredQuantity <= 0) {
      return {
        approved: false,
        reason: 'invalid_order_size',
        computedNotionalUsd: 0,
        computedQuantity: 0,
      };
    }

    const orderNotional = clamp(desiredNotional);
    const orderQty = clamp(desiredQuantity);

    const equityUsd = this.computeEquityUsd(agent, (symbol) => (symbol === intent.symbol ? priceUsd : undefined));

    if (orderNotional > agent.riskLimits.maxOrderNotionalUsd) {
      return { approved: false, reason: 'max_order_notional_exceeded', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
    }

    if (equityUsd > 0 && orderNotional > equityUsd * agent.riskLimits.maxPositionSizePct) {
      return { approved: false, reason: 'position_size_pct_exceeded', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
    }

    const currentGross = this.computeGrossExposureUsd(agent, (symbol) => (symbol === intent.symbol ? priceUsd : undefined));
    const projectedGross = intent.side === 'buy' ? currentGross + orderNotional : Math.max(0, currentGross - orderNotional);

    if (projectedGross > agent.riskLimits.maxGrossExposureUsd) {
      return { approved: false, reason: 'gross_exposure_cap_exceeded', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
    }

    const todayLoss = Math.min(0, agent.dailyRealizedPnlUsd[dayKey(now)] ?? 0);
    if (Math.abs(todayLoss) >= agent.riskLimits.dailyLossCapUsd) {
      return { approved: false, reason: 'daily_loss_cap_reached', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
    }

    const drawdown = agent.peakEquityUsd > 0 ? (agent.peakEquityUsd - equityUsd) / agent.peakEquityUsd : 0;
    if (drawdown >= agent.riskLimits.maxDrawdownPct) {
      return { approved: false, reason: 'drawdown_guard_triggered', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
    }

    if (agent.lastTradeAt) {
      const elapsedMs = now.getTime() - new Date(agent.lastTradeAt).getTime();
      if (elapsedMs < agent.riskLimits.cooldownSeconds * 1000) {
        return { approved: false, reason: 'cooldown_active', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
      }
    }

    if (intent.side === 'sell') {
      const currentQty = agent.positions[intent.symbol]?.quantity ?? 0;
      if (orderQty > currentQty) {
        return { approved: false, reason: 'insufficient_position_for_sell', computedNotionalUsd: orderNotional, computedQuantity: orderQty };
      }
    }

    return {
      approved: true,
      computedNotionalUsd: orderNotional,
      computedQuantity: orderQty,
    };
  }

  computeEquityUsd(agent: Agent, priceResolver: (symbol: string) => number | undefined): number {
    const inventoryValue = Object.values(agent.positions).reduce((sum, position) => {
      const px = priceResolver(position.symbol) ?? position.avgEntryPriceUsd;
      return sum + (position.quantity * px);
    }, 0);

    return clamp(agent.cashUsd + inventoryValue);
  }

  computeGrossExposureUsd(agent: Agent, priceResolver: (symbol: string) => number | undefined): number {
    const gross = Object.values(agent.positions).reduce((sum, position) => {
      const px = priceResolver(position.symbol) ?? position.avgEntryPriceUsd;
      return sum + Math.abs(position.quantity * px);
    }, 0);

    return clamp(gross);
  }
}
