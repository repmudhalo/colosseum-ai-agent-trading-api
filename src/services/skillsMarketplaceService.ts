/**
 * Skills Marketplace V2 Service.
 *
 * A marketplace where agents can publish, discover, purchase, and rate
 * reusable trading skills (entry timing, risk calibration, exit signals, etc.).
 * Skills are distinct from strategies — they are composable building blocks.
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type SkillCategory =
  | 'entry-signal'
  | 'exit-signal'
  | 'risk-management'
  | 'position-sizing'
  | 'timing'
  | 'portfolio';

export const SKILL_CATEGORIES: SkillCategory[] = [
  'entry-signal',
  'exit-signal',
  'risk-management',
  'position-sizing',
  'timing',
  'portfolio',
];

export interface SkillDefinition {
  name: string;
  description: string;
  category: SkillCategory;
  version: string;
  priceUsd: number;
  tags: string[];
  config?: Record<string, unknown>;
}

export interface PublishedSkill {
  id: string;
  agentId: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: string;
  priceUsd: number;
  tags: string[];
  config?: Record<string, unknown>;
  purchaseCount: number;
  totalRevenue: number;
  ratings: SkillRating[];
  avgRating: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPurchase {
  id: string;
  buyerAgentId: string;
  skillId: string;
  priceUsd: number;
  purchasedAt: string;
}

export interface SkillRating {
  agentId: string;
  rating: number;
  review: string;
  createdAt: string;
}

export interface SkillStats {
  skillId: string;
  name: string;
  category: SkillCategory;
  purchaseCount: number;
  avgRating: number;
  totalRevenue: number;
  ratingDistribution: Record<number, number>;
}

export interface ListSkillsFilters {
  category?: SkillCategory;
  minRating?: number;
  maxPrice?: number;
  tag?: string;
  search?: string;
  sortBy?: 'rating' | 'purchases' | 'price' | 'newest';
  limit?: number;
  offset?: number;
}

// ─── Service ────────────────────────────────────────────────────────────

export class SkillsMarketplaceService {
  private skills = new Map<string, PublishedSkill>();
  private purchases: SkillPurchase[] = [];

  constructor(private readonly store: StateStore) {}

  publishSkill(agentId: string, skill: SkillDefinition): PublishedSkill {
    const state = this.store.snapshot();

    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found. Only registered agents can publish skills.');
    }

    if (!SKILL_CATEGORIES.includes(skill.category)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Invalid category. Must be one of: ${SKILL_CATEGORIES.join(', ')}`);
    }

    if (skill.priceUsd < 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Skill price must be non-negative.');
    }

    if (!skill.name || skill.name.trim().length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Skill name must be at least 2 characters.');
    }

    const now = isoNow();
    const published: PublishedSkill = {
      id: uuid(), agentId, name: skill.name.trim(), description: skill.description,
      category: skill.category, version: skill.version || '1.0.0', priceUsd: skill.priceUsd,
      tags: skill.tags || [], config: skill.config, purchaseCount: 0, totalRevenue: 0,
      ratings: [], avgRating: 0, createdAt: now, updatedAt: now,
    };

    this.skills.set(published.id, published);
    return published;
  }

  listSkills(filters: ListSkillsFilters = {}): PublishedSkill[] {
    let results = Array.from(this.skills.values());

    if (filters.category) results = results.filter((s) => s.category === filters.category);
    if (filters.minRating !== undefined) results = results.filter((s) => s.avgRating >= filters.minRating!);
    if (filters.maxPrice !== undefined) results = results.filter((s) => s.priceUsd <= filters.maxPrice!);
    if (filters.tag) { const tag = filters.tag.toLowerCase(); results = results.filter((s) => s.tags.some((t) => t.toLowerCase() === tag)); }
    if (filters.search) { const q = filters.search.toLowerCase(); results = results.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)); }

    const sortBy = filters.sortBy || 'newest';
    switch (sortBy) {
      case 'rating': results.sort((a, b) => b.avgRating - a.avgRating); break;
      case 'purchases': results.sort((a, b) => b.purchaseCount - a.purchaseCount); break;
      case 'price': results.sort((a, b) => a.priceUsd - b.priceUsd); break;
      case 'newest': default: results.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
    }

    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 50, 200);
    return results.slice(offset, offset + limit);
  }

  purchaseSkill(buyerAgentId: string, skillId: string): SkillPurchase {
    const state = this.store.snapshot();
    const buyer = state.agents[buyerAgentId];
    if (!buyer) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Buyer agent not found.');

    const skill = this.skills.get(skillId);
    if (!skill) throw new DomainError(ErrorCode.SkillNotFound, 404, 'Skill not found.');
    if (skill.agentId === buyerAgentId) throw new DomainError(ErrorCode.InvalidPayload, 400, 'Cannot purchase your own skill.');

    if (this.purchases.some((p) => p.buyerAgentId === buyerAgentId && p.skillId === skillId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 409, 'Agent has already purchased this skill.');
    }
    if (buyer.cashUsd < skill.priceUsd) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Insufficient funds. Requires $${skill.priceUsd}, available $${buyer.cashUsd}.`);
    }

    const purchase: SkillPurchase = { id: uuid(), buyerAgentId, skillId, priceUsd: skill.priceUsd, purchasedAt: isoNow() };
    skill.purchaseCount += 1;
    skill.totalRevenue += skill.priceUsd;
    skill.updatedAt = isoNow();
    this.purchases.push(purchase);
    return purchase;
  }

  rateSkill(agentId: string, skillId: string, rating: number, review: string): SkillRating {
    const state = this.store.snapshot();
    if (!state.agents[agentId]) throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');

    const skill = this.skills.get(skillId);
    if (!skill) throw new DomainError(ErrorCode.SkillNotFound, 404, 'Skill not found.');
    if (!this.purchases.some((p) => p.buyerAgentId === agentId && p.skillId === skillId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Must purchase a skill before rating it.');
    }
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Rating must be an integer between 1 and 5.');
    }
    if (skill.ratings.some((r) => r.agentId === agentId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 409, 'Agent has already rated this skill.');
    }

    const skillRating: SkillRating = { agentId, rating, review: review.trim(), createdAt: isoNow() };
    skill.ratings.push(skillRating);
    const totalRating = skill.ratings.reduce((sum, r) => sum + r.rating, 0);
    skill.avgRating = Number((totalRating / skill.ratings.length).toFixed(2));
    skill.updatedAt = isoNow();
    return skillRating;
  }

  getSkillStats(skillId: string): SkillStats {
    const skill = this.skills.get(skillId);
    if (!skill) throw new DomainError(ErrorCode.SkillNotFound, 404, 'Skill not found.');

    const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of skill.ratings) ratingDistribution[r.rating] = (ratingDistribution[r.rating] || 0) + 1;

    return { skillId: skill.id, name: skill.name, category: skill.category, purchaseCount: skill.purchaseCount, avgRating: skill.avgRating, totalRevenue: skill.totalRevenue, ratingDistribution };
  }

  getById(skillId: string): PublishedSkill | undefined {
    return this.skills.get(skillId);
  }
}
