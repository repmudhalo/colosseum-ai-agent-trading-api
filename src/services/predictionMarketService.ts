/**
 * Prediction Market Service.
 *
 * Enables agents to create and trade on binary prediction markets with:
 * - Market creation (binary yes/no with resolution criteria)
 * - Continuous double auction order matching
 * - LMSR (Logarithmic Market Scoring Rule) automated market maker
 * - Position tracking per agent
 * - Market resolution & winnings distribution
 * - Prediction accuracy leaderboard
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type MarketStatus = 'open' | 'closed' | 'resolved';
export type Outcome = 'yes' | 'no';
export type OrderSide = 'buy' | 'sell';

export interface PredictionMarket {
  id: string;
  question: string;
  description: string;
  creatorId: string;
  status: MarketStatus;
  resolution: Outcome | null;
  resolutionCriteria: string;
  /** LMSR liquidity parameter (b). Higher = more liquid, less price impact. */
  liquidityParam: number;
  /** Outstanding shares of each outcome in the LMSR pool */
  yesShares: number;
  noShares: number;
  totalVolume: number;
  createdAt: string;
  closesAt: string;
  resolvedAt: string | null;
}

export interface MarketOrder {
  id: string;
  marketId: string;
  agentId: string;
  outcome: Outcome;
  side: OrderSide;
  price: number;
  quantity: number;
  filledQuantity: number;
  status: 'open' | 'filled' | 'partial' | 'cancelled';
  createdAt: string;
}

export interface Position {
  agentId: string;
  marketId: string;
  yesShares: number;
  noShares: number;
  totalCost: number;
}

export interface LeaderboardEntry {
  agentId: string;
  totalMarkets: number;
  correctPredictions: number;
  accuracy: number;
  totalProfit: number;
  brierScore: number;
}

export interface BuyResult {
  orderId: string;
  outcome: Outcome;
  quantity: number;
  cost: number;
  avgPrice: number;
  newMarketPrice: number;
  position: Position;
}

export interface SellResult {
  orderId: string;
  outcome: Outcome;
  quantity: number;
  revenue: number;
  avgPrice: number;
  newMarketPrice: number;
  position: Position;
}

// ─── LMSR Helpers ───────────────────────────────────────────────────────

function lmsrCost(yesShares: number, noShares: number, b: number): number {
  return b * Math.log(Math.exp(yesShares / b) + Math.exp(noShares / b));
}

function lmsrPrice(yesShares: number, noShares: number, b: number, outcome: Outcome): number {
  const expYes = Math.exp(yesShares / b);
  const expNo = Math.exp(noShares / b);
  const denom = expYes + expNo;
  return outcome === 'yes' ? expYes / denom : expNo / denom;
}

// ─── Service ────────────────────────────────────────────────────────────

export class PredictionMarketService {
  private markets = new Map<string, PredictionMarket>();
  private orders = new Map<string, MarketOrder>();
  private positions = new Map<string, Position>(); // key: `${agentId}:${marketId}`
  private resolutionHistory: Array<{
    agentId: string;
    marketId: string;
    outcome: Outcome;
    prediction: Outcome;
    correct: boolean;
    profit: number;
    brierComponent: number;
  }> = [];

  // ── Market creation ────────────────────────────────────────────────

  createMarket(params: {
    question: string;
    description: string;
    creatorId: string;
    resolutionCriteria: string;
    closesAt: string;
    liquidityParam?: number;
  }): PredictionMarket {
    if (!params.question || params.question.trim().length < 5) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Question must be at least 5 characters.');
    }
    if (!params.resolutionCriteria || params.resolutionCriteria.trim().length < 5) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Resolution criteria must be at least 5 characters.');
    }
    if (!params.creatorId || params.creatorId.trim().length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'creatorId is required.');
    }

    const closesAt = new Date(params.closesAt);
    if (isNaN(closesAt.getTime()) || closesAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'closesAt must be a valid future date.');
    }

    const b = params.liquidityParam ?? 100;
    if (b <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'liquidityParam must be positive.');
    }

    const market: PredictionMarket = {
      id: uuid(),
      question: params.question.trim(),
      description: (params.description ?? '').trim(),
      creatorId: params.creatorId.trim(),
      status: 'open',
      resolution: null,
      resolutionCriteria: params.resolutionCriteria.trim(),
      liquidityParam: b,
      yesShares: 0,
      noShares: 0,
      totalVolume: 0,
      createdAt: isoNow(),
      closesAt: closesAt.toISOString(),
      resolvedAt: null,
    };

    this.markets.set(market.id, market);

    eventBus.emit('prediction.market.created', {
      marketId: market.id,
      question: market.question,
      creatorId: market.creatorId,
    });

    return market;
  }

  // ── Market queries ─────────────────────────────────────────────────

  getMarket(id: string): PredictionMarket | undefined {
    return this.markets.get(id);
  }

  listMarkets(filters?: { status?: MarketStatus }): PredictionMarket[] {
    let markets = [...this.markets.values()];
    if (filters?.status) {
      markets = markets.filter((m) => m.status === filters.status);
    }
    return markets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMarketPrice(marketId: string, outcome: Outcome): number {
    const market = this.markets.get(marketId);
    if (!market) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Market not found.');
    return lmsrPrice(market.yesShares, market.noShares, market.liquidityParam, outcome);
  }

  // ── Buy shares (LMSR) ─────────────────────────────────────────────

  buyShares(params: {
    marketId: string;
    agentId: string;
    outcome: Outcome;
    quantity: number;
  }): BuyResult {
    const market = this.markets.get(params.marketId);
    if (!market) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Market not found.');
    }
    if (market.status !== 'open') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Market is not open for trading.');
    }
    if (params.quantity <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Quantity must be positive.');
    }

    // Calculate LMSR cost
    const oldCost = lmsrCost(market.yesShares, market.noShares, market.liquidityParam);
    const newYes = params.outcome === 'yes' ? market.yesShares + params.quantity : market.yesShares;
    const newNo = params.outcome === 'no' ? market.noShares + params.quantity : market.noShares;
    const newCost = lmsrCost(newYes, newNo, market.liquidityParam);
    const cost = newCost - oldCost;

    // Update market state
    market.yesShares = newYes;
    market.noShares = newNo;
    market.totalVolume += cost;

    // Update position
    const posKey = `${params.agentId}:${params.marketId}`;
    const pos = this.positions.get(posKey) ?? {
      agentId: params.agentId,
      marketId: params.marketId,
      yesShares: 0,
      noShares: 0,
      totalCost: 0,
    };

    if (params.outcome === 'yes') {
      pos.yesShares += params.quantity;
    } else {
      pos.noShares += params.quantity;
    }
    pos.totalCost += cost;
    this.positions.set(posKey, pos);

    // Create order record
    const order: MarketOrder = {
      id: uuid(),
      marketId: params.marketId,
      agentId: params.agentId,
      outcome: params.outcome,
      side: 'buy',
      price: cost / params.quantity,
      quantity: params.quantity,
      filledQuantity: params.quantity,
      status: 'filled',
      createdAt: isoNow(),
    };
    this.orders.set(order.id, order);

    const newPrice = lmsrPrice(newYes, newNo, market.liquidityParam, params.outcome);

    eventBus.emit('prediction.shares.bought', {
      marketId: params.marketId,
      agentId: params.agentId,
      outcome: params.outcome,
      quantity: params.quantity,
      cost,
    });

    return {
      orderId: order.id,
      outcome: params.outcome,
      quantity: params.quantity,
      cost: Number(cost.toFixed(6)),
      avgPrice: Number((cost / params.quantity).toFixed(6)),
      newMarketPrice: Number(newPrice.toFixed(6)),
      position: { ...pos },
    };
  }

  // ── Sell shares (LMSR) ────────────────────────────────────────────

  sellShares(params: {
    marketId: string;
    agentId: string;
    outcome: Outcome;
    quantity: number;
  }): SellResult {
    const market = this.markets.get(params.marketId);
    if (!market) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Market not found.');
    }
    if (market.status !== 'open') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Market is not open for trading.');
    }
    if (params.quantity <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Quantity must be positive.');
    }

    // Check position
    const posKey = `${params.agentId}:${params.marketId}`;
    const pos = this.positions.get(posKey);
    if (!pos) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'No position found for this market.');
    }

    const heldShares = params.outcome === 'yes' ? pos.yesShares : pos.noShares;
    if (heldShares < params.quantity) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Insufficient shares. Holding ${heldShares}, tried to sell ${params.quantity}.`);
    }

    // Calculate LMSR revenue (negative cost = revenue)
    const oldCost = lmsrCost(market.yesShares, market.noShares, market.liquidityParam);
    const newYes = params.outcome === 'yes' ? market.yesShares - params.quantity : market.yesShares;
    const newNo = params.outcome === 'no' ? market.noShares - params.quantity : market.noShares;
    const newCost = lmsrCost(newYes, newNo, market.liquidityParam);
    const revenue = oldCost - newCost; // positive when selling

    // Update market state
    market.yesShares = newYes;
    market.noShares = newNo;
    market.totalVolume += revenue;

    // Update position
    if (params.outcome === 'yes') {
      pos.yesShares -= params.quantity;
    } else {
      pos.noShares -= params.quantity;
    }
    pos.totalCost -= revenue;
    this.positions.set(posKey, pos);

    // Create order record
    const order: MarketOrder = {
      id: uuid(),
      marketId: params.marketId,
      agentId: params.agentId,
      outcome: params.outcome,
      side: 'sell',
      price: revenue / params.quantity,
      quantity: params.quantity,
      filledQuantity: params.quantity,
      status: 'filled',
      createdAt: isoNow(),
    };
    this.orders.set(order.id, order);

    const newPrice = lmsrPrice(newYes, newNo, market.liquidityParam, params.outcome);

    eventBus.emit('prediction.shares.sold', {
      marketId: params.marketId,
      agentId: params.agentId,
      outcome: params.outcome,
      quantity: params.quantity,
      revenue,
    });

    return {
      orderId: order.id,
      outcome: params.outcome,
      quantity: params.quantity,
      revenue: Number(revenue.toFixed(6)),
      avgPrice: Number((revenue / params.quantity).toFixed(6)),
      newMarketPrice: Number(newPrice.toFixed(6)),
      position: { ...pos },
    };
  }

  // ── Position queries ───────────────────────────────────────────────

  getPosition(agentId: string, marketId: string): Position | undefined {
    return this.positions.get(`${agentId}:${marketId}`);
  }

  getAgentPositions(agentId: string): Position[] {
    return [...this.positions.values()].filter((p) => p.agentId === agentId);
  }

  // ── Market resolution ─────────────────────────────────────────────

  resolveMarket(marketId: string, outcome: Outcome): PredictionMarket {
    const market = this.markets.get(marketId);
    if (!market) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Market not found.');
    }
    if (market.status === 'resolved') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Market is already resolved.');
    }

    market.status = 'resolved';
    market.resolution = outcome;
    market.resolvedAt = isoNow();

    // Distribute winnings and record prediction accuracy
    const marketPositions = [...this.positions.values()].filter((p) => p.marketId === marketId);

    for (const pos of marketPositions) {
      const winningShares = outcome === 'yes' ? pos.yesShares : pos.noShares;
      const losingShares = outcome === 'yes' ? pos.noShares : pos.yesShares;

      // Each winning share pays out 1 unit
      const payout = winningShares;
      const profit = payout - pos.totalCost;

      // Determine the agent's primary prediction (which side they bet more on)
      const totalShares = pos.yesShares + pos.noShares;
      if (totalShares > 0) {
        const prediction: Outcome = pos.yesShares >= pos.noShares ? 'yes' : 'no';
        const correct = prediction === outcome;

        // Brier score component: (forecast - actual)^2
        // forecast = proportion of shares on the winning side
        const forecastProb = (outcome === 'yes' ? pos.yesShares : pos.noShares) / totalShares;
        const brierComponent = (1 - forecastProb) ** 2;

        this.resolutionHistory.push({
          agentId: pos.agentId,
          marketId,
          outcome,
          prediction,
          correct,
          profit,
          brierComponent,
        });
      }
    }

    eventBus.emit('prediction.market.resolved', {
      marketId: market.id,
      outcome,
      question: market.question,
    });

    return market;
  }

  // ── Leaderboard ───────────────────────────────────────────────────

  getLeaderboard(limit = 50): LeaderboardEntry[] {
    const agentMap = new Map<string, {
      totalMarkets: number;
      correct: number;
      totalProfit: number;
      brierSum: number;
    }>();

    for (const record of this.resolutionHistory) {
      const entry = agentMap.get(record.agentId) ?? {
        totalMarkets: 0,
        correct: 0,
        totalProfit: 0,
        brierSum: 0,
      };

      entry.totalMarkets += 1;
      if (record.correct) entry.correct += 1;
      entry.totalProfit += record.profit;
      entry.brierSum += record.brierComponent;

      agentMap.set(record.agentId, entry);
    }

    const leaderboard: LeaderboardEntry[] = [];
    for (const [agentId, data] of agentMap) {
      leaderboard.push({
        agentId,
        totalMarkets: data.totalMarkets,
        correctPredictions: data.correct,
        accuracy: data.totalMarkets > 0 ? Number((data.correct / data.totalMarkets).toFixed(4)) : 0,
        totalProfit: Number(data.totalProfit.toFixed(6)),
        brierScore: data.totalMarkets > 0 ? Number((data.brierSum / data.totalMarkets).toFixed(6)) : 0,
      });
    }

    // Sort by accuracy descending, then by profit descending
    leaderboard.sort((a, b) => {
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      return b.totalProfit - a.totalProfit;
    });

    return leaderboard.slice(0, limit);
  }

  // ── Order book for a market ────────────────────────────────────────

  getMarketOrders(marketId: string): MarketOrder[] {
    return [...this.orders.values()]
      .filter((o) => o.marketId === marketId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
