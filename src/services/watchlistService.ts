/**
 * Token Watchlist & Trending Service.
 *
 * Agents maintain a watchlist of tokens they're interested in.
 * Provides trending view of most-watched tokens across all agents.
 */

import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

export interface WatchlistEntry {
  id: string;
  agentId: string;
  symbol: string;
  notes?: string;
  addedAt: string;
}

export interface WatchlistEntryWithPrice extends WatchlistEntry {
  currentPriceUsd: number | null;
}

export interface TrendingToken {
  symbol: string;
  watchCount: number;
  currentPriceUsd: number | null;
}

const MAX_WATCHLIST_PER_AGENT = 200;

export class WatchlistService {
  /** agentId → symbol → WatchlistEntry */
  private watchlists: Map<string, Map<string, WatchlistEntry>> = new Map();

  constructor(private readonly store: StateStore) {}

  /**
   * Add a token to an agent's watchlist.
   */
  addToWatchlist(agentId: string, symbol: string, notes?: string): WatchlistEntry {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const upper = symbol.toUpperCase();

    if (!this.watchlists.has(agentId)) {
      this.watchlists.set(agentId, new Map());
    }

    const agentWatchlist = this.watchlists.get(agentId)!;

    // If already watching, update notes
    if (agentWatchlist.has(upper)) {
      const existing = agentWatchlist.get(upper)!;
      if (notes !== undefined) {
        existing.notes = notes;
      }
      return structuredClone(existing);
    }

    if (agentWatchlist.size >= MAX_WATCHLIST_PER_AGENT) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Watchlist limit reached (max ${MAX_WATCHLIST_PER_AGENT} tokens).`,
      );
    }

    const entry: WatchlistEntry = {
      id: uuid(),
      agentId,
      symbol: upper,
      notes,
      addedAt: isoNow(),
    };

    agentWatchlist.set(upper, entry);

    eventBus.emit('watchlist.added', {
      agentId,
      symbol: upper,
      entryId: entry.id,
    });

    return structuredClone(entry);
  }

  /**
   * Remove a token from an agent's watchlist.
   */
  removeFromWatchlist(agentId: string, symbol: string): { removed: boolean } {
    const upper = symbol.toUpperCase();
    const agentWatchlist = this.watchlists.get(agentId);

    if (!agentWatchlist || !agentWatchlist.has(upper)) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Token not found in watchlist.');
    }

    agentWatchlist.delete(upper);

    eventBus.emit('watchlist.removed', {
      agentId,
      symbol: upper,
    });

    return { removed: true };
  }

  /**
   * Get an agent's watchlist with current prices from oracle/market state.
   */
  getWatchlist(agentId: string): WatchlistEntryWithPrice[] {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const agentWatchlist = this.watchlists.get(agentId);
    if (!agentWatchlist) return [];

    return Array.from(agentWatchlist.values())
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .map((entry) => ({
        ...structuredClone(entry),
        currentPriceUsd: state.marketPricesUsd[entry.symbol] ?? null,
      }));
  }

  /**
   * Get trending tokens — most watched across all agents, sorted by watch count.
   */
  getTrending(): TrendingToken[] {
    const state = this.store.snapshot();
    const counts: Map<string, number> = new Map();

    for (const agentWatchlist of this.watchlists.values()) {
      for (const symbol of agentWatchlist.keys()) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([symbol, watchCount]) => ({
        symbol,
        watchCount,
        currentPriceUsd: state.marketPricesUsd[symbol] ?? null,
      }))
      .sort((a, b) => b.watchCount - a.watchCount);
  }
}
