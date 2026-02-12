import { describe, expect, it, beforeEach } from 'vitest';
import { PredictionMarketService } from '../src/services/predictionMarketService.js';

describe('PredictionMarketService', () => {
  let service: PredictionMarketService;
  const futureDate = new Date(Date.now() + 86_400_000).toISOString(); // +1 day

  beforeEach(() => {
    service = new PredictionMarketService();
  });

  // ─── Market Creation ─────────────────────────────────────────────────

  it('should create a prediction market', () => {
    const market = service.createMarket({
      question: 'Will SOL reach $200 by end of month?',
      description: 'Binary prediction on SOL price target',
      creatorId: 'agent-1',
      resolutionCriteria: 'SOL price on CoinGecko at 2026-02-28 23:59 UTC',
      closesAt: futureDate,
    });

    expect(market.id).toBeDefined();
    expect(market.question).toBe('Will SOL reach $200 by end of month?');
    expect(market.creatorId).toBe('agent-1');
    expect(market.status).toBe('open');
    expect(market.resolution).toBeNull();
    expect(market.liquidityParam).toBe(100);
    expect(market.yesShares).toBe(0);
    expect(market.noShares).toBe(0);
  });

  it('should reject market with short question', () => {
    expect(() =>
      service.createMarket({
        question: 'Hi?',
        description: '',
        creatorId: 'agent-1',
        resolutionCriteria: 'Some valid resolution criteria here',
        closesAt: futureDate,
      }),
    ).toThrow(/at least 5 characters/);
  });

  it('should reject market with past closesAt', () => {
    expect(() =>
      service.createMarket({
        question: 'Will BTC reach $100k?',
        description: '',
        creatorId: 'agent-1',
        resolutionCriteria: 'BTC price on CoinGecko at closing date',
        closesAt: '2020-01-01T00:00:00Z',
      }),
    ).toThrow(/future date/);
  });

  // ─── LMSR Pricing ────────────────────────────────────────────────────

  it('should start with equal prices for yes/no (0.5 each)', () => {
    const market = service.createMarket({
      question: 'Will ETH flip BTC by market cap?',
      description: 'The flippening prediction',
      creatorId: 'agent-1',
      resolutionCriteria: 'ETH market cap > BTC market cap on CoinGecko',
      closesAt: futureDate,
    });

    const yesPrice = service.getMarketPrice(market.id, 'yes');
    const noPrice = service.getMarketPrice(market.id, 'no');

    expect(yesPrice).toBeCloseTo(0.5, 4);
    expect(noPrice).toBeCloseTo(0.5, 4);
    expect(yesPrice + noPrice).toBeCloseTo(1.0, 4);
  });

  it('should move price up when buying yes shares', () => {
    const market = service.createMarket({
      question: 'Will SOL TVL reach $20B?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'DefiLlama SOL TVL at closing date',
      closesAt: futureDate,
    });

    const priceBefore = service.getMarketPrice(market.id, 'yes');

    service.buyShares({
      marketId: market.id,
      agentId: 'agent-2',
      outcome: 'yes',
      quantity: 50,
    });

    const priceAfter = service.getMarketPrice(market.id, 'yes');
    expect(priceAfter).toBeGreaterThan(priceBefore);
    // Prices should still sum to 1
    const noPrice = service.getMarketPrice(market.id, 'no');
    expect(priceAfter + noPrice).toBeCloseTo(1.0, 4);
  });

  // ─── Buying Shares ───────────────────────────────────────────────────

  it('should buy shares and update position', () => {
    const market = service.createMarket({
      question: 'Will Solana process 100k TPS?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'Solana Explorer average TPS over 24h',
      closesAt: futureDate,
    });

    const result = service.buyShares({
      marketId: market.id,
      agentId: 'agent-2',
      outcome: 'yes',
      quantity: 10,
    });

    expect(result.orderId).toBeDefined();
    expect(result.outcome).toBe('yes');
    expect(result.quantity).toBe(10);
    expect(result.cost).toBeGreaterThan(0);
    expect(result.avgPrice).toBeGreaterThan(0);
    expect(result.position.yesShares).toBe(10);
    expect(result.position.noShares).toBe(0);
  });

  it('should reject buying on a non-existent market', () => {
    expect(() =>
      service.buyShares({
        marketId: 'nonexistent',
        agentId: 'agent-1',
        outcome: 'yes',
        quantity: 10,
      }),
    ).toThrow(/not found/);
  });

  it('should reject buying zero or negative quantity', () => {
    const market = service.createMarket({
      question: 'Test market for negative qty?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'Manual resolution by oracle',
      closesAt: futureDate,
    });

    expect(() =>
      service.buyShares({
        marketId: market.id,
        agentId: 'agent-1',
        outcome: 'yes',
        quantity: 0,
      }),
    ).toThrow(/positive/);
  });

  // ─── Selling Shares ──────────────────────────────────────────────────

  it('should sell shares and update position', () => {
    const market = service.createMarket({
      question: 'Will Jupiter DEX volume exceed $1B daily?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'Jupiter daily volume on closing date',
      closesAt: futureDate,
    });

    // Buy first
    service.buyShares({
      marketId: market.id,
      agentId: 'agent-2',
      outcome: 'yes',
      quantity: 20,
    });

    // Then sell some
    const result = service.sellShares({
      marketId: market.id,
      agentId: 'agent-2',
      outcome: 'yes',
      quantity: 10,
    });

    expect(result.orderId).toBeDefined();
    expect(result.outcome).toBe('yes');
    expect(result.quantity).toBe(10);
    expect(result.revenue).toBeGreaterThan(0);
    expect(result.position.yesShares).toBe(10);
  });

  it('should reject selling more shares than held', () => {
    const market = service.createMarket({
      question: 'Will Marinade TVL reach $5B?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'Marinade Finance TVL on DefiLlama',
      closesAt: futureDate,
    });

    service.buyShares({
      marketId: market.id,
      agentId: 'agent-2',
      outcome: 'yes',
      quantity: 5,
    });

    expect(() =>
      service.sellShares({
        marketId: market.id,
        agentId: 'agent-2',
        outcome: 'yes',
        quantity: 10,
      }),
    ).toThrow(/Insufficient shares/);
  });

  it('should reject selling without a position', () => {
    const market = service.createMarket({
      question: 'Will Helium reach 1M hotspots?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'Helium Explorer hotspot count',
      closesAt: futureDate,
    });

    expect(() =>
      service.sellShares({
        marketId: market.id,
        agentId: 'agent-no-position',
        outcome: 'yes',
        quantity: 1,
      }),
    ).toThrow(/No position/);
  });

  // ─── Market Resolution ───────────────────────────────────────────────

  it('should resolve a market and record results', () => {
    const market = service.createMarket({
      question: 'Will SOL be above $150 on Feb 28?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'SOL price on CoinGecko',
      closesAt: futureDate,
    });

    // Agent-2 bets YES, Agent-3 bets NO
    service.buyShares({ marketId: market.id, agentId: 'agent-2', outcome: 'yes', quantity: 30 });
    service.buyShares({ marketId: market.id, agentId: 'agent-3', outcome: 'no', quantity: 20 });

    const resolved = service.resolveMarket(market.id, 'yes');

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('yes');
    expect(resolved.resolvedAt).toBeDefined();
  });

  it('should reject resolving an already resolved market', () => {
    const market = service.createMarket({
      question: 'Will BTC reach $200k in 2026?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'BTC price on CoinGecko at year end',
      closesAt: futureDate,
    });

    service.resolveMarket(market.id, 'no');

    expect(() =>
      service.resolveMarket(market.id, 'yes'),
    ).toThrow(/already resolved/);
  });

  it('should not allow trading on a resolved market', () => {
    const market = service.createMarket({
      question: 'Will BONK reach $0.001?',
      description: '',
      creatorId: 'agent-1',
      resolutionCriteria: 'BONK price on Jupiter',
      closesAt: futureDate,
    });

    service.resolveMarket(market.id, 'yes');

    expect(() =>
      service.buyShares({ marketId: market.id, agentId: 'agent-2', outcome: 'yes', quantity: 10 }),
    ).toThrow(/not open/);
  });

  // ─── Leaderboard ─────────────────────────────────────────────────────

  it('should compute leaderboard with accuracy and profit', () => {
    // Create and resolve two markets
    const m1 = service.createMarket({
      question: 'Market 1: Will SOL reach $200?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Price check',
      closesAt: futureDate,
    });

    const m2 = service.createMarket({
      question: 'Market 2: Will ETH reach $5000?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Price check',
      closesAt: futureDate,
    });

    // Agent-A bets YES on both
    service.buyShares({ marketId: m1.id, agentId: 'agent-A', outcome: 'yes', quantity: 20 });
    service.buyShares({ marketId: m2.id, agentId: 'agent-A', outcome: 'yes', quantity: 20 });

    // Agent-B bets NO on both
    service.buyShares({ marketId: m1.id, agentId: 'agent-B', outcome: 'no', quantity: 20 });
    service.buyShares({ marketId: m2.id, agentId: 'agent-B', outcome: 'no', quantity: 20 });

    // Resolve: m1 = yes, m2 = no
    service.resolveMarket(m1.id, 'yes');
    service.resolveMarket(m2.id, 'no');

    const leaderboard = service.getLeaderboard();

    expect(leaderboard.length).toBe(2);
    // Both should have 50% accuracy (each got one right, one wrong)
    for (const entry of leaderboard) {
      expect(entry.totalMarkets).toBe(2);
      expect(entry.correctPredictions).toBe(1);
      expect(entry.accuracy).toBeCloseTo(0.5, 2);
    }
  });

  // ─── Position Tracking ───────────────────────────────────────────────

  it('should track positions across multiple markets', () => {
    const m1 = service.createMarket({
      question: 'Position tracking test market 1?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Manual',
      closesAt: futureDate,
    });

    const m2 = service.createMarket({
      question: 'Position tracking test market 2?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Manual',
      closesAt: futureDate,
    });

    service.buyShares({ marketId: m1.id, agentId: 'agent-X', outcome: 'yes', quantity: 15 });
    service.buyShares({ marketId: m2.id, agentId: 'agent-X', outcome: 'no', quantity: 25 });

    const positions = service.getAgentPositions('agent-X');
    expect(positions.length).toBe(2);

    const pos1 = service.getPosition('agent-X', m1.id);
    expect(pos1?.yesShares).toBe(15);
    expect(pos1?.noShares).toBe(0);

    const pos2 = service.getPosition('agent-X', m2.id);
    expect(pos2?.yesShares).toBe(0);
    expect(pos2?.noShares).toBe(25);
  });

  // ─── List & Filter Markets ───────────────────────────────────────────

  it('should list and filter markets by status', () => {
    const m1 = service.createMarket({
      question: 'Open market for filtering test?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Manual',
      closesAt: futureDate,
    });

    const m2 = service.createMarket({
      question: 'Resolved market for filtering test?',
      description: '',
      creatorId: 'creator',
      resolutionCriteria: 'Manual',
      closesAt: futureDate,
    });

    service.resolveMarket(m2.id, 'yes');

    const allMarkets = service.listMarkets();
    expect(allMarkets.length).toBe(2);

    const openMarkets = service.listMarkets({ status: 'open' });
    expect(openMarkets.length).toBe(1);
    expect(openMarkets[0].id).toBe(m1.id);

    const resolvedMarkets = service.listMarkets({ status: 'resolved' });
    expect(resolvedMarkets.length).toBe(1);
    expect(resolvedMarkets[0].id).toBe(m2.id);
  });
});
