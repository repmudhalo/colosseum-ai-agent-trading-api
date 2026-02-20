/**
 * PostgreSQL database service.
 * Provides connection pooling and query helpers.
 */

import pg from 'pg';
import { AppConfig } from '../../config.js';

const { Pool } = pg;

export interface LoreSignal {
  id: number;
  mintAddress: string;
  event: string;
  boxType: string | null;
  symbol: string | null;
  name: string | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  receivedAt: Date;
  metadata: Record<string, unknown> | null;
}

export class Database {
  private pool: pg.Pool | null = null;
  private readonly config: AppConfig['database'];

  constructor(config: AppConfig['database']) {
    this.config = config;
  }

  /**
   * Initialize the database connection pool.
   * Returns false if DATABASE_URL is not configured (database features disabled).
   */
  async init(): Promise<boolean> {
    if (!this.config.connectionString) {
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: this.config.maxConnections,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });

      // Test connection
      await this.pool.query('SELECT 1');
      return true;
    } catch (err) {
      console.error('[Database] Failed to connect:', err);
      this.pool = null;
      return false;
    }
  }

  /**
   * Check if database is available.
   */
  isAvailable(): boolean {
    return this.pool !== null;
  }

  /**
   * Execute a query. Returns null if database is not available.
   */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T> | null> {
    if (!this.pool) return null;
    try {
      return await this.pool.query<T>(text, params);
    } catch (err) {
      console.error('[Database] Query error:', err);
      throw err;
    }
  }

  // Column alias fragment: maps snake_case DB columns to camelCase TypeScript fields.
  // pg returns column names as-is, so we need aliases to match the LoreSignal interface.
  private static readonly LORE_COLUMNS = `
    id,
    mint_address AS "mintAddress",
    event,
    box_type AS "boxType",
    symbol,
    name,
    market_cap_usd AS "marketCapUsd",
    price_usd AS "priceUsd",
    received_at AS "receivedAt",
    metadata
  `;

  /**
   * Store a LORE signal in the database.
   */
  async storeLoreSignal(data: {
    mintAddress: string;
    event: string;
    boxType: string | null;
    symbol: string | null;
    name: string | null;
    marketCapUsd: number | null;
    priceUsd: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<LoreSignal | null> {
    if (!this.isAvailable()) return null;

    const result = await this.query<LoreSignal>(
      `INSERT INTO lore_signals (mint_address, event, box_type, symbol, name, market_cap_usd, price_usd, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${Database.LORE_COLUMNS}`,
      [
        data.mintAddress,
        data.event,
        data.boxType,
        data.symbol,
        data.name,
        data.marketCapUsd,
        data.priceUsd,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ],
    );

    return result?.rows[0] ?? null;
  }

  /**
   * Get signal history for a token, ordered by most recent first.
   */
  async getLoreSignalHistory(mintAddress: string, limit = 50): Promise<LoreSignal[]> {
    if (!this.isAvailable()) return [];

    const result = await this.query<LoreSignal>(
      `SELECT ${Database.LORE_COLUMNS} FROM lore_signals
       WHERE mint_address = $1
       ORDER BY received_at DESC
       LIMIT $2`,
      [mintAddress, limit],
    );

    return result?.rows ?? [];
  }

  /**
   * Get the most recent signal for a token.
   */
  async getLastLoreSignal(mintAddress: string): Promise<LoreSignal | null> {
    const history = await this.getLoreSignalHistory(mintAddress, 1);
    return history[0] ?? null;
  }

  /**
   * Check if this is the first signal ever received for a token.
   */
  async isFirstSignal(mintAddress: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const result = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM lore_signals WHERE mint_address = $1`,
      [mintAddress],
    );
    return result ? Number(result.rows[0]?.count ?? 0) === 1 : false;
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
