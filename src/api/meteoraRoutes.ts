/**
 * Meteora DLMM API Routes
 *
 * RESTful endpoints for the Meteora DLMM integration:
 * - Pool discovery with filters
 * - Position management (paper trading)
 * - Pool analytics and bin distribution
 * - Strategy configuration (auto-compound, rebalance)
 * - IL estimation and top pool rankings
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MeteoraService } from '../services/meteoraService.js';
import { DomainError, ErrorCode, toErrorEnvelope } from '../errors/taxonomy.js';

const sendDomainError = (reply: FastifyReply, error: unknown): void => {
  if (error instanceof DomainError) {
    void reply.code(error.statusCode).send(toErrorEnvelope(error.code, error.message, error.details));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Map common errors to proper HTTP codes
  if (message.includes('not found') || message.includes('Not found')) {
    void reply.code(404).send(toErrorEnvelope(ErrorCode.AgentNotFound, message));
    return;
  }

  void reply.code(500).send(toErrorEnvelope(ErrorCode.InternalError, message));
};

// ─── Request Schemas ────────────────────────────────────────────────────

const openPositionSchema = z.object({
  agentId: z.string().min(2),
  poolAddress: z.string().min(10),
  strategy: z.enum(['spot', 'curve', 'bid-ask']),
  depositAmountX: z.number().nonnegative(),
  depositAmountY: z.number().nonnegative(),
  lowerBinId: z.number().int().optional(),
  upperBinId: z.number().int().optional(),
});

const ilEstimateSchema = z.object({
  poolAddress: z.string().min(10),
  entryPrice: z.number().positive(),
  currentPrice: z.number().positive().optional(),
  depositValueUsd: z.number().positive(),
  durationDays: z.number().positive().optional(),
});

const autoCompoundSchema = z.object({
  positionId: z.string().min(1),
  enabled: z.boolean(),
  intervalHours: z.number().positive().optional(),
});

// ─── Route Registration ─────────────────────────────────────────────────

export function registerMeteoraRoutes(
  app: FastifyInstance,
  meteoraService: MeteoraService,
): void {
  // ─── Pool Discovery ───────────────────────────────────────────────

  /**
   * GET /meteora/pools — List DLMM pools with optional filters.
   */
  app.get('/meteora/pools', async (request) => {
    const query = request.query as {
      token?: string;
      minTvl?: string;
      minApr?: string;
      sortBy?: string;
      limit?: string;
    };

    const filters: {
      token?: string;
      minTvl?: number;
      minApr?: number;
      sortBy?: 'apr' | 'tvl' | 'volume' | 'fees';
      limit?: number;
    } = {};

    if (query.token) filters.token = query.token;
    if (query.minTvl) filters.minTvl = Number(query.minTvl);
    if (query.minApr) filters.minApr = Number(query.minApr);
    if (query.sortBy && ['apr', 'tvl', 'volume', 'fees'].includes(query.sortBy)) {
      filters.sortBy = query.sortBy as 'apr' | 'tvl' | 'volume' | 'fees';
    }
    if (query.limit) filters.limit = Math.min(Math.max(Number(query.limit), 1), 500);

    const pools = await meteoraService.listPools(filters);
    return { pools, total: pools.length };
  });

  /**
   * GET /meteora/pools/:address — Pool details + analytics.
   */
  app.get('/meteora/pools/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    const pool = await meteoraService.fetchPool(address);
    if (!pool) {
      return reply.code(404).send(toErrorEnvelope(
        ErrorCode.AgentNotFound,
        `Meteora pool not found: ${address}`,
      ));
    }

    const analytics = meteoraService.getPoolAnalytics(address);

    return { pool, analytics };
  });

  /**
   * GET /meteora/pools/:address/bins — Bin distribution data.
   */
  app.get('/meteora/pools/:address/bins', async (request, reply) => {
    const { address } = request.params as { address: string };

    const bins = meteoraService.getBinDistribution(address);
    if (!bins) {
      return reply.code(404).send(toErrorEnvelope(
        ErrorCode.AgentNotFound,
        `Meteora pool not found: ${address}`,
      ));
    }

    return { poolAddress: address, bins, totalBins: bins.length };
  });

  // ─── Position Management ──────────────────────────────────────────

  /**
   * POST /meteora/positions — Open a new LP position (paper mode).
   */
  app.post('/meteora/positions', async (request, reply) => {
    const parse = openPositionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid position payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const position = meteoraService.openPosition(parse.data);
      return reply.code(201).send({ position });
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  /**
   * GET /meteora/positions — List agent positions.
   */
  app.get('/meteora/positions', async (request) => {
    const query = request.query as { agentId?: string; status?: string };

    let positions = query.agentId
      ? meteoraService.getPositions(query.agentId)
      : meteoraService.getAllPositions();

    if (query.status === 'active' || query.status === 'closed') {
      positions = positions.filter((p) => p.status === query.status);
    }

    return { positions, total: positions.length };
  });

  /**
   * GET /meteora/positions/:id — Get position details.
   */
  app.get('/meteora/positions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const position = meteoraService.getPosition(id);
    if (!position) {
      return reply.code(404).send(toErrorEnvelope(
        ErrorCode.AgentNotFound,
        `Position not found: ${id}`,
      ));
    }

    return { position };
  });

  /**
   * DELETE /meteora/positions/:id — Close a position (remove liquidity).
   */
  app.delete('/meteora/positions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const position = meteoraService.closePosition(id);
      return { position, message: 'Position closed successfully.' };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  /**
   * POST /meteora/positions/:id/claim — Claim accrued fees.
   */
  app.post('/meteora/positions/:id/claim', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = meteoraService.claimFees(id);
      return {
        position: result.position,
        claimedUsd: result.claimedUsd,
        message: `Claimed $${result.claimedUsd} in fees.`,
      };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  /**
   * POST /meteora/positions/:id/rebalance — Rebalance position around current price.
   */
  app.post('/meteora/positions/:id/rebalance', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = meteoraService.rebalancePosition(id);
      return { rebalance: result };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  // ─── Analytics ────────────────────────────────────────────────────

  /**
   * GET /meteora/analytics/top-pools — Top pools ranked by APR.
   */
  app.get('/meteora/analytics/top-pools', async (request) => {
    const query = request.query as {
      limit?: string;
      minTvl?: string;
      sortBy?: string;
    };

    const opts: { limit?: number; minTvl?: number; sortBy?: 'apr' | 'volume' | 'fees' } = {};
    if (query.limit) opts.limit = Math.min(Math.max(Number(query.limit), 1), 100);
    if (query.minTvl) opts.minTvl = Number(query.minTvl);
    if (query.sortBy && ['apr', 'volume', 'fees'].includes(query.sortBy)) {
      opts.sortBy = query.sortBy as 'apr' | 'volume' | 'fees';
    }

    const pools = meteoraService.getTopPools(opts);
    return { pools, total: pools.length };
  });

  /**
   * GET /meteora/analytics/il-estimate — Impermanent loss calculator.
   */
  app.get('/meteora/analytics/il-estimate', async (request, reply) => {
    const query = request.query as {
      poolAddress?: string;
      entryPrice?: string;
      currentPrice?: string;
      depositValueUsd?: string;
      durationDays?: string;
    };

    // Support both GET query params and POST body
    const params = {
      poolAddress: query.poolAddress ?? '',
      entryPrice: Number(query.entryPrice ?? 0),
      currentPrice: query.currentPrice ? Number(query.currentPrice) : undefined,
      depositValueUsd: Number(query.depositValueUsd ?? 0),
      durationDays: query.durationDays ? Number(query.durationDays) : undefined,
    };

    if (!params.poolAddress || params.entryPrice <= 0 || params.depositValueUsd <= 0) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Required query params: poolAddress, entryPrice (>0), depositValueUsd (>0).',
      ));
    }

    const estimate = meteoraService.estimateIL(params);
    return { estimate };
  });

  /**
   * POST /meteora/analytics/il-estimate — IL calculator (POST variant).
   */
  app.post('/meteora/analytics/il-estimate', async (request, reply) => {
    const parse = ilEstimateSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid IL estimate payload.',
        parse.error.flatten(),
      ));
    }

    const estimate = meteoraService.estimateIL(parse.data);
    return { estimate };
  });

  // ─── Strategy ─────────────────────────────────────────────────────

  /**
   * POST /meteora/strategies/auto-compound — Enable/configure auto-compounding.
   */
  app.post('/meteora/strategies/auto-compound', async (request, reply) => {
    const parse = autoCompoundSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope(
        ErrorCode.InvalidPayload,
        'Invalid auto-compound payload.',
        parse.error.flatten(),
      ));
    }

    try {
      const config = meteoraService.configureAutoCompound(parse.data);
      return { config };
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });
}
