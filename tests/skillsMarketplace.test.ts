import { describe, expect, it, vi } from 'vitest';
import { SkillsMarketplaceService } from '../src/services/skillsMarketplaceService.js';
import { AppState, Agent } from '../src/types.js';
import { createDefaultState } from '../src/infra/storage/defaultState.js';

function createMockStore(state: AppState) {
  return { snapshot: () => structuredClone(state), transaction: vi.fn(), init: vi.fn(), flush: vi.fn() } as any;
}

function makeAgent(id: string, name: string, cashUsd = 10_000): Agent {
  return {
    id, name, apiKey: `key-${id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    startingCapitalUsd: 10_000, cashUsd, realizedPnlUsd: 0, peakEquityUsd: 10_000,
    riskLimits: { maxPositionSizePct: 0.25, maxOrderNotionalUsd: 2500, maxGrossExposureUsd: 7500, dailyLossCapUsd: 1000, maxDrawdownPct: 0.2, cooldownSeconds: 3 },
    positions: {}, dailyRealizedPnlUsd: {}, riskRejectionsByReason: {}, strategyId: 'momentum-v1',
  };
}

const baseSkill = { name: 'Entry Timing Optimizer', description: 'Optimizes entry timing based on order flow analysis', category: 'entry-signal' as const, version: '1.0.0', priceUsd: 50, tags: ['timing', 'order-flow'] };

describe('SkillsMarketplaceService', () => {
  function setup(agentCount = 3) {
    const state = createDefaultState();
    for (let i = 1; i <= agentCount; i++) state.agents[`agent-${i}`] = makeAgent(`agent-${i}`, `Agent ${i}`);
    const store = createMockStore(state);
    return { state, store, service: new SkillsMarketplaceService(store) };
  }

  it('publishes a skill for a registered agent', () => {
    const { service } = setup();
    const skill = service.publishSkill('agent-1', baseSkill);
    expect(skill.id).toBeDefined();
    expect(skill.agentId).toBe('agent-1');
    expect(skill.name).toBe('Entry Timing Optimizer');
    expect(skill.category).toBe('entry-signal');
    expect(skill.priceUsd).toBe(50);
    expect(skill.purchaseCount).toBe(0);
    expect(skill.avgRating).toBe(0);
    expect(skill.ratings).toEqual([]);
  });

  it('rejects publish from unknown agent', () => { const { service } = setup(); expect(() => service.publishSkill('ghost', baseSkill)).toThrow('Agent not found'); });
  it('rejects invalid category', () => { const { service } = setup(); expect(() => service.publishSkill('agent-1', { ...baseSkill, category: 'invalid' as any })).toThrow('Invalid category'); });
  it('rejects negative price', () => { const { service } = setup(); expect(() => service.publishSkill('agent-1', { ...baseSkill, priceUsd: -10 })).toThrow('non-negative'); });
  it('rejects too-short name', () => { const { service } = setup(); expect(() => service.publishSkill('agent-1', { ...baseSkill, name: 'x' })).toThrow('at least 2'); });

  it('lists all skills', () => {
    const { service } = setup();
    service.publishSkill('agent-1', { ...baseSkill, name: 'Skill A' });
    service.publishSkill('agent-2', { ...baseSkill, name: 'Skill B', category: 'risk-management' });
    const list = service.listSkills();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(['Skill A', 'Skill B']);
  });

  it('filters by category', () => {
    const { service } = setup();
    service.publishSkill('agent-1', { ...baseSkill, category: 'entry-signal' });
    service.publishSkill('agent-2', { ...baseSkill, name: 'Risk Skill', category: 'risk-management' });
    const filtered = service.listSkills({ category: 'entry-signal' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].category).toBe('entry-signal');
  });

  it('filters by maxPrice', () => {
    const { service } = setup();
    service.publishSkill('agent-1', { ...baseSkill, priceUsd: 10 });
    service.publishSkill('agent-2', { ...baseSkill, name: 'Expensive', priceUsd: 100 });
    expect(service.listSkills({ maxPrice: 50 })).toHaveLength(1);
  });

  it('supports search filter', () => {
    const { service } = setup();
    service.publishSkill('agent-1', { ...baseSkill, name: 'Alpha Signal Detector' });
    service.publishSkill('agent-2', { ...baseSkill, name: 'Risk Calibrator' });
    expect(service.listSkills({ search: 'alpha' })).toHaveLength(1);
  });

  it('sorts by price', () => {
    const { service } = setup();
    service.publishSkill('agent-1', { ...baseSkill, name: 'Expensive', priceUsd: 100 });
    service.publishSkill('agent-2', { ...baseSkill, name: 'Cheap', priceUsd: 5 });
    const sorted = service.listSkills({ sortBy: 'price' });
    expect(sorted[0].name).toBe('Cheap');
  });

  it('paginates with limit and offset', () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) service.publishSkill('agent-1', { ...baseSkill, name: `Skill ${i}` });
    expect(service.listSkills({ limit: 2, offset: 2 })).toHaveLength(2);
  });

  it('allows an agent to purchase a skill', () => {
    const { service } = setup();
    const skill = service.publishSkill('agent-1', baseSkill);
    const purchase = service.purchaseSkill('agent-2', skill.id);
    expect(purchase.buyerAgentId).toBe('agent-2');
    expect(purchase.priceUsd).toBe(50);
    expect(service.getById(skill.id)!.purchaseCount).toBe(1);
    expect(service.getById(skill.id)!.totalRevenue).toBe(50);
  });

  it('prevents self-purchase', () => { const { service } = setup(); const s = service.publishSkill('agent-1', baseSkill); expect(() => service.purchaseSkill('agent-1', s.id)).toThrow('Cannot purchase your own'); });
  it('prevents duplicate purchase', () => { const { service } = setup(); const s = service.publishSkill('agent-1', baseSkill); service.purchaseSkill('agent-2', s.id); expect(() => service.purchaseSkill('agent-2', s.id)).toThrow('already purchased'); });
  it('rejects purchase of non-existent skill', () => { const { service } = setup(); expect(() => service.purchaseSkill('agent-2', 'nonexistent')).toThrow('Skill not found'); });
  it('rejects purchase when buyer not found', () => { const { service } = setup(); const s = service.publishSkill('agent-1', baseSkill); expect(() => service.purchaseSkill('ghost', s.id)).toThrow('Buyer agent not found'); });

  it('rejects purchase with insufficient funds', () => {
    const state = createDefaultState();
    state.agents['agent-1'] = makeAgent('agent-1', 'A1', 10_000);
    state.agents['agent-2'] = makeAgent('agent-2', 'A2', 10);
    const service = new SkillsMarketplaceService(createMockStore(state));
    const s = service.publishSkill('agent-1', { ...baseSkill, priceUsd: 50 });
    expect(() => service.purchaseSkill('agent-2', s.id)).toThrow('Insufficient funds');
  });

  it('allows a purchaser to rate a skill', () => {
    const { service } = setup();
    const s = service.publishSkill('agent-1', baseSkill);
    service.purchaseSkill('agent-2', s.id);
    const rating = service.rateSkill('agent-2', s.id, 5, 'Excellent skill!');
    expect(rating.rating).toBe(5);
    expect(service.getById(s.id)!.avgRating).toBe(5);
  });

  it('computes average rating from multiple ratings', () => {
    const { service } = setup();
    const s = service.publishSkill('agent-1', baseSkill);
    service.purchaseSkill('agent-2', s.id);
    service.purchaseSkill('agent-3', s.id);
    service.rateSkill('agent-2', s.id, 5, 'Great!');
    service.rateSkill('agent-3', s.id, 3, 'OK');
    expect(service.getById(s.id)!.avgRating).toBe(4);
  });

  it('rejects rating without purchase', () => { const { service } = setup(); const s = service.publishSkill('agent-1', baseSkill); expect(() => service.rateSkill('agent-2', s.id, 5, 'Good')).toThrow('Must purchase'); });
  it('rejects duplicate rating', () => { const { service } = setup(); const s = service.publishSkill('agent-1', baseSkill); service.purchaseSkill('agent-2', s.id); service.rateSkill('agent-2', s.id, 4, 'Nice'); expect(() => service.rateSkill('agent-2', s.id, 5, 'Changed')).toThrow('already rated'); });

  it('rejects invalid rating values', () => {
    const { service } = setup();
    const s = service.publishSkill('agent-1', baseSkill);
    service.purchaseSkill('agent-2', s.id);
    expect(() => service.rateSkill('agent-2', s.id, 0, 'Bad')).toThrow('between 1 and 5');
    expect(() => service.rateSkill('agent-2', s.id, 6, 'Great')).toThrow('between 1 and 5');
    expect(() => service.rateSkill('agent-2', s.id, 3.5, 'Mid')).toThrow('between 1 and 5');
  });

  it('rejects rating for non-existent skill', () => { const { service } = setup(); expect(() => service.rateSkill('agent-2', 'nonexistent', 5, 'Good')).toThrow('Skill not found'); });

  it('returns correct stats with rating distribution', () => {
    const { service } = setup();
    const s = service.publishSkill('agent-1', baseSkill);
    service.purchaseSkill('agent-2', s.id);
    service.purchaseSkill('agent-3', s.id);
    service.rateSkill('agent-2', s.id, 5, 'Great!');
    service.rateSkill('agent-3', s.id, 3, 'OK');
    const stats = service.getSkillStats(s.id);
    expect(stats.purchaseCount).toBe(2);
    expect(stats.avgRating).toBe(4);
    expect(stats.totalRevenue).toBe(100);
    expect(stats.ratingDistribution[5]).toBe(1);
    expect(stats.ratingDistribution[3]).toBe(1);
    expect(stats.ratingDistribution[1]).toBe(0);
  });

  it('throws for non-existent skill stats', () => { const { service } = setup(); expect(() => service.getSkillStats('nonexistent')).toThrow('Skill not found'); });
  it('returns undefined for non-existent skill', () => { const { service } = setup(); expect(service.getById('nonexistent')).toBeUndefined(); });
});
