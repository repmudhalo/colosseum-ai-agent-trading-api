/**
 * Advanced order types: Limit Orders & Stop-Loss.
 *
 * Agents can place conditional orders that trigger automatically
 * when market prices reach specified thresholds.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired';
export type StopLossStatus = 'open' | 'triggered' | 'cancelled' | 'expired';

export interface LimitOrder {
  id: string;
  agentId: string;
  symbol: string;
  side: OrderSide;
  /** Target price to trigger execution. */
  price: number;
  /** Notional value in USD to trade when triggered. */
  notionalUsd: number;
  /** ISO timestamp after which the order expires. */
  expiry: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  filledAt?: string;
}

export interface StopLoss {
  id: string;
  agentId: string;
  symbol: string;
  /** Price threshold that triggers the stop-loss. */
  triggerPrice: number;
  /** Notional value in USD to sell when triggered. */
  notionalUsd: number;
  status: StopLossStatus;
  createdAt: string;
  updatedAt: string;
  triggeredAt?: string;
}

export type AdvancedOrder = LimitOrder | StopLoss;

/**
 * Determine if a limit order should fill given the current price.
 * - Buy limit: fills when current price <= order price (price dropped to desired level).
 * - Sell limit: fills when current price >= order price (price rose to desired level).
 */
export function shouldFillLimitOrder(order: LimitOrder, currentPrice: number): boolean {
  if (order.status !== 'open') return false;

  if (new Date(order.expiry).getTime() <= Date.now()) return false;

  if (order.side === 'buy') {
    return currentPrice <= order.price;
  }

  return currentPrice >= order.price;
}

/**
 * Determine if a stop-loss should trigger given the current price.
 * Stop-loss triggers when current price drops to or below the trigger price.
 */
export function shouldTriggerStopLoss(stopLoss: StopLoss, currentPrice: number): boolean {
  if (stopLoss.status !== 'open') return false;

  return currentPrice <= stopLoss.triggerPrice;
}
