import { describe, expect, it, beforeEach } from 'vitest';
import {
  DataPipelineService,
  DataSource,
  NormalizedRecord,
  DataSubscription,
  MetricDefinition,
} from '../src/services/dataPipelineService.js';
import { eventBus } from '../src/infra/eventBus.js';

describe('DataPipelineService', () => {
  let service: DataPipelineService;

  beforeEach(() => {
    eventBus.clear();
    service = new DataPipelineService();
  });

  // ─── 1. Default Sources ───────────────────────────────────────────────

  it('registers default data sources on construction', () => {
    const sources = service.listSources();
    expect(sources.length).toBeGreaterThanOrEqual(4);

    const ids = sources.map((s) => s.id);
    expect(ids).toContain('coingecko');
    expect(ids).toContain('birdeye');
    expect(ids).toContain('helius');
    expect(ids).toContain('custom-webhook');
  });

  // ─── 2. Register Custom Source ────────────────────────────────────────

  it('registers a custom data source', () => {
    const source = service.registerSource({
      id: 'my-oracle',
      name: 'My Custom Oracle',
      type: 'api',
      endpoint: 'https://oracle.example.com',
      refreshIntervalMs: 5000,
      retentionMs: 3600000,
      tags: ['oracle', 'custom'],
    });

    expect(source.id).toBe('my-oracle');
    expect(source.name).toBe('My Custom Oracle');
    expect(source.type).toBe('api');
    expect(source.status).toBe('active');
    expect(source.ingestCount).toBe(0);
    expect(source.tags).toContain('oracle');

    const all = service.listSources();
    expect(all.find((s) => s.id === 'my-oracle')).toBeDefined();
  });

  // ─── 3. Data Ingestion Pipeline ───────────────────────────────────────

  it('ingests data through normalization pipeline (raw → cleaned → enriched)', () => {
    const record = service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: {
        symbol: '  SOL  ',
        priceUsd: 142.5,
        volume24h: 1_200_000,
        nullField: null,
      },
    });

    // Raw preserved
    expect(record.raw.symbol).toBe('  SOL  ');
    expect(record.raw.priceUsd).toBe(142.5);

    // Cleaned: trimmed strings, no undefined
    expect(record.cleaned.symbol).toBe('SOL');
    expect(record.cleaned.priceUsd).toBe(142.5);

    // Enriched: has additional metadata
    expect(record.enriched._sourceId).toBe('coingecko');
    expect(record.enriched._dataType).toBe('price');
    expect(record.enriched._numericFieldCount).toBe(2); // priceUsd, volume24h
    expect(record.enriched._enrichedAt).toBeDefined();

    expect(record.id).toBeDefined();
    expect(record.sourceId).toBe('coingecko');
    expect(record.dataType).toBe('price');
  });

  // ─── 4. Quality Scoring ───────────────────────────────────────────────

  it('computes quality scores for ingested data', () => {
    const record = service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: {
        symbol: 'SOL',
        priceUsd: 142.5,
        volume24h: 1_200_000,
        marketCap: 55_000_000_000,
      },
    });

    // All fields present, data is fresh, all consistent
    expect(record.quality.completeness).toBe(1);
    expect(record.quality.freshness).toBeGreaterThan(0.5);
    expect(record.quality.consistency).toBe(1);
    expect(record.quality.overall).toBeGreaterThan(0.5);
    expect(record.quality.overall).toBeLessThanOrEqual(1);
  });

  it('penalizes quality for null/empty fields', () => {
    const record = service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: {
        symbol: 'SOL',
        priceUsd: null,
        volume24h: '',
        marketCap: undefined,
      },
    });

    // Only 'symbol' is non-null/non-empty out of the defined keys
    expect(record.quality.completeness).toBeLessThan(1);
  });

  // ─── 5. Time-Series Query ─────────────────────────────────────────────

  it('queries time-series data with filters', () => {
    // Ingest multiple records
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 140 },
      timestamp: '2025-01-01T00:00:00Z',
    });

    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 145 },
      timestamp: '2025-01-02T00:00:00Z',
    });

    service.ingest({
      sourceId: 'coingecko',
      dataType: 'volume',
      payload: { symbol: 'SOL', volume: 1_000_000 },
      timestamp: '2025-01-02T12:00:00Z',
    });

    // Query all from coingecko
    const all = service.query({ sourceId: 'coingecko' });
    expect(all.length).toBe(3);

    // Query only price data
    const prices = service.query({ sourceId: 'coingecko', dataType: 'price' });
    expect(prices.length).toBe(2);

    // Query with time range
    const ranged = service.query({
      sourceId: 'coingecko',
      from: '2025-01-01T12:00:00Z',
      to: '2025-01-02T06:00:00Z',
    });
    expect(ranged.length).toBe(1);
    expect(ranged[0].cleaned.priceUsd).toBe(145);

    // Query with limit
    const limited = service.query({ sourceId: 'coingecko', limit: 1 });
    expect(limited.length).toBe(1);
  });

  // ─── 6. Quality Report ────────────────────────────────────────────────

  it('generates quality reports per source', () => {
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 142 },
    });
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'BTC', priceUsd: 43000 },
    });

    const reports = service.getQualityReport('coingecko');
    expect(reports.length).toBe(1);

    const report = reports[0];
    expect(report.sourceId).toBe('coingecko');
    expect(report.totalRecords).toBe(2);
    expect(report.avgCompleteness).toBeGreaterThan(0);
    expect(report.avgOverall).toBeGreaterThan(0);
    expect(report.generatedAt).toBeDefined();
    expect(report.oldestRecord).toBeDefined();
    expect(report.newestRecord).toBeDefined();
  });

  it('generates quality reports for all sources', () => {
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 142 },
    });

    const reports = service.getQualityReport();
    // Should have reports for all registered sources (at least 4 defaults)
    expect(reports.length).toBeGreaterThanOrEqual(4);
  });

  // ─── 7. Subscription System ───────────────────────────────────────────

  it('creates subscriptions and delivers matching records', () => {
    const sub = service.subscribe({
      agentId: 'agent-1',
      sourceId: 'coingecko',
      dataType: 'price',
    });

    expect(sub.id).toBeDefined();
    expect(sub.agentId).toBe('agent-1');
    expect(sub.sourceId).toBe('coingecko');
    expect(sub.deliveredCount).toBe(0);

    // Track delivered events
    const delivered: unknown[] = [];
    eventBus.on('data.delivered', (_event, data) => delivered.push(data));

    // Ingest matching record
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 142 },
    });

    expect(delivered.length).toBe(1);

    // Ingest non-matching record (different dataType)
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'volume',
      payload: { symbol: 'SOL', volume: 1000 },
    });

    expect(delivered.length).toBe(1); // should not increase

    // Check subscription updated
    const subs = service.listSubscriptions('agent-1');
    expect(subs.length).toBe(1);
    expect(subs[0].deliveredCount).toBe(1);
    expect(subs[0].lastDeliveredAt).toBeDefined();
  });

  it('prevents duplicate subscriptions', () => {
    const sub1 = service.subscribe({
      agentId: 'agent-1',
      sourceId: 'coingecko',
      dataType: 'price',
    });

    const sub2 = service.subscribe({
      agentId: 'agent-1',
      sourceId: 'coingecko',
      dataType: 'price',
    });

    // Should return existing subscription
    expect(sub2.id).toBe(sub1.id);

    const subs = service.listSubscriptions('agent-1');
    expect(subs.length).toBe(1);
  });

  // ─── 8. Derived Metrics Engine ────────────────────────────────────────

  it('registers and computes derived metrics', () => {
    // Register a metric definition
    const def = service.registerMetric({
      id: 'avg-sol-price',
      name: 'Average SOL Price',
      sourceId: 'coingecko',
      dataType: 'price',
      aggregation: 'avg',
      field: 'priceUsd',
      windowMs: 3_600_000, // 1 hour
    });

    expect(def.id).toBe('avg-sol-price');
    expect(def.aggregation).toBe('avg');

    // Ingest some data
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { priceUsd: 140 },
    });
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { priceUsd: 150 },
    });
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { priceUsd: 160 },
    });

    const result = service.computeMetric('avg-sol-price');
    expect(result).not.toBeNull();
    expect(result!.metricId).toBe('avg-sol-price');
    expect(result!.value).toBe(150);
    expect(result!.sampleCount).toBe(3);
  });

  it('supports multiple aggregation types', () => {
    // Ingest data
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { priceUsd: 10 } });
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { priceUsd: 20 } });
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { priceUsd: 30 } });

    // Register various metrics
    service.registerMetric({ id: 'm-sum', name: 'Sum', sourceId: 'coingecko', dataType: 'price', aggregation: 'sum', field: 'priceUsd' });
    service.registerMetric({ id: 'm-min', name: 'Min', sourceId: 'coingecko', dataType: 'price', aggregation: 'min', field: 'priceUsd' });
    service.registerMetric({ id: 'm-max', name: 'Max', sourceId: 'coingecko', dataType: 'price', aggregation: 'max', field: 'priceUsd' });
    service.registerMetric({ id: 'm-count', name: 'Count', sourceId: 'coingecko', dataType: 'price', aggregation: 'count', field: 'priceUsd' });
    service.registerMetric({ id: 'm-last', name: 'Last', sourceId: 'coingecko', dataType: 'price', aggregation: 'last', field: 'priceUsd' });
    service.registerMetric({ id: 'm-first', name: 'First', sourceId: 'coingecko', dataType: 'price', aggregation: 'first', field: 'priceUsd' });
    service.registerMetric({ id: 'm-stddev', name: 'StdDev', sourceId: 'coingecko', dataType: 'price', aggregation: 'stddev', field: 'priceUsd' });

    expect(service.computeMetric('m-sum')!.value).toBe(60);
    expect(service.computeMetric('m-min')!.value).toBe(10);
    expect(service.computeMetric('m-max')!.value).toBe(30);
    expect(service.computeMetric('m-count')!.value).toBe(3);
    expect(service.computeMetric('m-last')!.value).toBe(30);
    expect(service.computeMetric('m-first')!.value).toBe(10);

    // StdDev of [10, 20, 30] = sqrt(((10-20)^2 + (20-20)^2 + (30-20)^2) / 3) ≈ 8.1650
    const stddev = service.computeMetric('m-stddev')!.value!;
    expect(stddev).toBeCloseTo(8.165, 2);
  });

  // ─── 9. Unknown Source Errors ─────────────────────────────────────────

  it('throws error when ingesting to unknown source', () => {
    expect(() =>
      service.ingest({
        sourceId: 'nonexistent',
        dataType: 'price',
        payload: { value: 1 },
      }),
    ).toThrow('Unknown data source: nonexistent');
  });

  // ─── 10. Event Emission ───────────────────────────────────────────────

  it('emits data.ingested events', () => {
    const events: unknown[] = [];
    eventBus.on('data.ingested', (_event, data) => events.push(data));

    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { priceUsd: 100 },
    });

    expect(events.length).toBe(1);
    const ev = events[0] as any;
    expect(ev.sourceId).toBe('coingecko');
    expect(ev.dataType).toBe('price');
    expect(ev.quality).toBeGreaterThan(0);
  });

  // ─── 11. Stats ────────────────────────────────────────────────────────

  it('returns pipeline stats', () => {
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { v: 1 } });
    service.ingest({ sourceId: 'birdeye', dataType: 'token', payload: { v: 2 } });
    service.subscribe({ agentId: 'a1', sourceId: 'coingecko' });
    service.registerMetric({
      id: 'test-m',
      name: 'Test',
      sourceId: 'coingecko',
      dataType: 'price',
      aggregation: 'avg',
      field: 'v',
    });

    const stats = service.getStats();
    expect(stats.totalSources).toBeGreaterThanOrEqual(4);
    expect(stats.totalRecords).toBe(2);
    expect(stats.totalSubscriptions).toBe(1);
    expect(stats.totalMetrics).toBe(1);
    expect(stats.recordsBySource.coingecko).toBe(1);
    expect(stats.recordsBySource.birdeye).toBe(1);
  });

  // ─── 12. Compute All Metrics ──────────────────────────────────────────

  it('computes all registered metrics at once', () => {
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { priceUsd: 100 } });
    service.ingest({ sourceId: 'coingecko', dataType: 'price', payload: { priceUsd: 200 } });

    service.registerMetric({ id: 'm1', name: 'Avg Price', sourceId: 'coingecko', dataType: 'price', aggregation: 'avg', field: 'priceUsd' });
    service.registerMetric({ id: 'm2', name: 'Max Price', sourceId: 'coingecko', dataType: 'price', aggregation: 'max', field: 'priceUsd' });

    const results = service.computeAllMetrics();
    expect(results.length).toBe(2);
    expect(results.find((r) => r.metricId === 'm1')!.value).toBe(150);
    expect(results.find((r) => r.metricId === 'm2')!.value).toBe(200);
  });

  // ─── 13. Subscription Filter Matching ─────────────────────────────────

  it('subscription filter matches on cleaned fields', () => {
    service.subscribe({
      agentId: 'agent-1',
      sourceId: 'coingecko',
      dataType: 'price',
      filter: { symbol: 'SOL' },
    });

    const delivered: unknown[] = [];
    eventBus.on('data.delivered', (_event, data) => delivered.push(data));

    // Matching record
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'SOL', priceUsd: 142 },
    });
    expect(delivered.length).toBe(1);

    // Non-matching record (different symbol)
    service.ingest({
      sourceId: 'coingecko',
      dataType: 'price',
      payload: { symbol: 'BTC', priceUsd: 43000 },
    });
    expect(delivered.length).toBe(1); // should not increase
  });

  // ─── 14. Unsubscribe ──────────────────────────────────────────────────

  it('unsubscribes successfully', () => {
    const sub = service.subscribe({
      agentId: 'agent-1',
      sourceId: 'coingecko',
    });

    expect(service.listSubscriptions('agent-1').length).toBe(1);

    const removed = service.unsubscribe(sub.id);
    expect(removed).toBe(true);
    expect(service.listSubscriptions('agent-1').length).toBe(0);

    // Unsubscribe non-existent
    expect(service.unsubscribe('nonexistent')).toBe(false);
  });

  // ─── 15. Source Update ────────────────────────────────────────────────

  it('updates existing source when re-registering with same id', () => {
    const original = service.getSource('coingecko')!;
    expect(original.name).toBe('CoinGecko Market Data');

    const updated = service.registerSource({
      id: 'coingecko',
      name: 'CoinGecko v2',
      type: 'api',
      endpoint: 'https://api.coingecko.com/api/v4',
    });

    expect(updated.name).toBe('CoinGecko v2');
    expect(updated.endpoint).toBe('https://api.coingecko.com/api/v4');

    // Total sources should not increase
    const sources = service.listSources();
    const cgSources = sources.filter((s) => s.id === 'coingecko');
    expect(cgSources.length).toBe(1);
  });
});
