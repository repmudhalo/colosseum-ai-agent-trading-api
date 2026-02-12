/**
 * Data Pipeline & ETL Service.
 *
 * Structured data ingestion for agent intelligence:
 * - Data source registry (CoinGecko, Birdeye, Helius, custom webhooks)
 * - Data normalization pipeline (raw → cleaned → enriched)
 * - Time-series storage with configurable retention
 * - Data quality scoring (completeness, freshness, consistency)
 * - Derived metrics engine (compute custom metrics from raw data)
 * - Data subscription system (agents subscribe to data feeds)
 */

import { z } from 'zod';
import { isoNow } from '../utils/time.js';
import { eventBus } from '../infra/eventBus.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

export const ingestSchema = z.object({
  sourceId: z.string().min(1).max(120),
  dataType: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string().datetime().optional(),
});

export const querySchema = z.object({
  sourceId: z.string().min(1).max(120).optional(),
  dataType: z.string().min(1).max(60).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export const subscribeSchema = z.object({
  agentId: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(120),
  dataType: z.string().min(1).max(60).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});

export const registerSourceSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  type: z.enum(['api', 'webhook', 'websocket', 'manual']),
  endpoint: z.string().max(500).optional(),
  refreshIntervalMs: z.number().int().positive().optional(),
  retentionMs: z.number().int().positive().optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
});

export const metricDefinitionSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  sourceId: z.string().min(1).max(120),
  dataType: z.string().min(1).max(60),
  aggregation: z.enum(['avg', 'sum', 'min', 'max', 'count', 'last', 'first', 'stddev']),
  field: z.string().min(1).max(120),
  windowMs: z.number().int().positive().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DataSource {
  id: string;
  name: string;
  type: 'api' | 'webhook' | 'websocket' | 'manual';
  endpoint?: string;
  refreshIntervalMs?: number;
  retentionMs: number;
  tags: string[];
  status: 'active' | 'inactive' | 'error';
  lastIngestAt?: string;
  ingestCount: number;
  createdAt: string;
}

export interface NormalizedRecord {
  id: string;
  sourceId: string;
  dataType: string;
  raw: Record<string, unknown>;
  cleaned: Record<string, unknown>;
  enriched: Record<string, unknown>;
  quality: RecordQuality;
  ingestedAt: string;
  sourceTimestamp: string;
}

export interface RecordQuality {
  completeness: number;   // 0–1: fraction of expected fields present & non-null
  freshness: number;      // 0–1: how recent relative to expected refresh interval
  consistency: number;    // 0–1: passes type/range checks
  overall: number;        // weighted average
}

export interface DataQualityReport {
  sourceId: string;
  totalRecords: number;
  avgCompleteness: number;
  avgFreshness: number;
  avgConsistency: number;
  avgOverall: number;
  oldestRecord?: string;
  newestRecord?: string;
  generatedAt: string;
}

export interface DataSubscription {
  id: string;
  agentId: string;
  sourceId: string;
  dataType?: string;
  filter?: Record<string, unknown>;
  createdAt: string;
  deliveredCount: number;
  lastDeliveredAt?: string;
}

export interface MetricDefinition {
  id: string;
  name: string;
  sourceId: string;
  dataType: string;
  aggregation: 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last' | 'first' | 'stddev';
  field: string;
  windowMs: number;
  createdAt: string;
}

export interface MetricResult {
  metricId: string;
  name: string;
  value: number | null;
  sampleCount: number;
  windowMs: number;
  computedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_METRIC_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const MAX_RECORDS_PER_SOURCE = 10_000;
const QUALITY_WEIGHTS = { completeness: 0.35, freshness: 0.35, consistency: 0.30 };

// ─── Helpers ────────────────────────────────────────────────────────────────

let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${(idCounter).toString(36)}`;
}

function extractNumericFields(obj: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      result[key] = value;
    }
  }
  return result;
}

function cleanPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      cleaned[key] = value.trim();
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function enrichPayload(
  cleaned: Record<string, unknown>,
  sourceId: string,
  dataType: string,
): Record<string, unknown> {
  const enriched = { ...cleaned };
  const numericFields = extractNumericFields(cleaned);
  const numericValues = Object.values(numericFields);

  if (numericValues.length > 0) {
    enriched._numericFieldCount = numericValues.length;
    enriched._numericSum = numericValues.reduce((a, b) => a + b, 0);
    enriched._numericAvg = (enriched._numericSum as number) / numericValues.length;
  }

  enriched._sourceId = sourceId;
  enriched._dataType = dataType;
  enriched._enrichedAt = isoNow();

  return enriched;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class DataPipelineService {
  private sources: Map<string, DataSource> = new Map();
  private records: Map<string, NormalizedRecord[]> = new Map(); // sourceId → records
  private subscriptions: Map<string, DataSubscription> = new Map();
  private metrics: Map<string, MetricDefinition> = new Map();

  constructor() {
    // Register default well-known data sources
    this.registerDefaultSources();
  }

  // ─── Source Registry ──────────────────────────────────────────────────

  private registerDefaultSources(): void {
    const defaults: Array<Omit<DataSource, 'status' | 'ingestCount' | 'createdAt'>> = [
      {
        id: 'coingecko',
        name: 'CoinGecko Market Data',
        type: 'api',
        endpoint: 'https://api.coingecko.com/api/v3',
        refreshIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        tags: ['market-data', 'prices', 'volume'],
      },
      {
        id: 'birdeye',
        name: 'Birdeye Solana Analytics',
        type: 'api',
        endpoint: 'https://public-api.birdeye.so',
        refreshIntervalMs: 30_000,
        retentionMs: 3 * 24 * 60 * 60 * 1000, // 3 days
        tags: ['solana', 'defi', 'analytics'],
      },
      {
        id: 'helius',
        name: 'Helius RPC & Webhooks',
        type: 'webhook',
        endpoint: 'https://api.helius.xyz',
        refreshIntervalMs: 10_000,
        retentionMs: 24 * 60 * 60 * 1000, // 1 day
        tags: ['solana', 'transactions', 'webhooks'],
      },
      {
        id: 'custom-webhook',
        name: 'Custom Webhook Ingestion',
        type: 'webhook',
        retentionMs: DEFAULT_RETENTION_MS,
        tags: ['custom', 'webhook'],
      },
    ];

    const now = isoNow();
    for (const src of defaults) {
      this.sources.set(src.id, {
        ...src,
        retentionMs: src.retentionMs ?? DEFAULT_RETENTION_MS,
        tags: src.tags ?? [],
        status: 'active',
        ingestCount: 0,
        createdAt: now,
      });
      this.records.set(src.id, []);
    }
  }

  registerSource(input: z.infer<typeof registerSourceSchema>): DataSource {
    if (this.sources.has(input.id)) {
      // Update existing source
      const existing = this.sources.get(input.id)!;
      const updated: DataSource = {
        ...existing,
        name: input.name,
        type: input.type,
        endpoint: input.endpoint,
        refreshIntervalMs: input.refreshIntervalMs ?? existing.refreshIntervalMs,
        retentionMs: input.retentionMs ?? existing.retentionMs,
        tags: input.tags ?? existing.tags,
      };
      this.sources.set(input.id, updated);
      return structuredClone(updated);
    }

    const source: DataSource = {
      id: input.id,
      name: input.name,
      type: input.type,
      endpoint: input.endpoint,
      refreshIntervalMs: input.refreshIntervalMs,
      retentionMs: input.retentionMs ?? DEFAULT_RETENTION_MS,
      tags: input.tags ?? [],
      status: 'active',
      ingestCount: 0,
      createdAt: isoNow(),
    };

    this.sources.set(source.id, source);
    this.records.set(source.id, []);
    return structuredClone(source);
  }

  listSources(): DataSource[] {
    return Array.from(this.sources.values()).map((s) => structuredClone(s));
  }

  getSource(sourceId: string): DataSource | undefined {
    const s = this.sources.get(sourceId);
    return s ? structuredClone(s) : undefined;
  }

  // ─── Ingestion & Normalization Pipeline ───────────────────────────────

  ingest(input: z.infer<typeof ingestSchema>): NormalizedRecord {
    const source = this.sources.get(input.sourceId);
    if (!source) {
      throw new Error(`Unknown data source: ${input.sourceId}`);
    }

    const now = isoNow();
    const sourceTimestamp = input.timestamp ?? now;

    // Stage 1: Clean
    const cleaned = cleanPayload(input.payload);

    // Stage 2: Enrich
    const enriched = enrichPayload(cleaned, input.sourceId, input.dataType);

    // Stage 3: Quality scoring
    const quality = this.scoreQuality(input.payload, cleaned, sourceTimestamp, source);

    const record: NormalizedRecord = {
      id: genId('rec'),
      sourceId: input.sourceId,
      dataType: input.dataType,
      raw: structuredClone(input.payload),
      cleaned,
      enriched,
      quality,
      ingestedAt: now,
      sourceTimestamp,
    };

    // Store
    let sourceRecords = this.records.get(input.sourceId);
    if (!sourceRecords) {
      sourceRecords = [];
      this.records.set(input.sourceId, sourceRecords);
    }
    sourceRecords.push(record);

    // Enforce max records
    if (sourceRecords.length > MAX_RECORDS_PER_SOURCE) {
      sourceRecords.splice(0, sourceRecords.length - MAX_RECORDS_PER_SOURCE);
    }

    // Update source metadata
    source.lastIngestAt = now;
    source.ingestCount += 1;

    // Apply retention
    this.applyRetention(input.sourceId);

    // Deliver to subscribers
    this.deliverToSubscribers(record);

    // Emit event
    eventBus.emit('data.ingested', {
      recordId: record.id,
      sourceId: record.sourceId,
      dataType: record.dataType,
      quality: record.quality.overall,
    });

    return structuredClone(record);
  }

  // ─── Quality Scoring ─────────────────────────────────────────────────

  private scoreQuality(
    raw: Record<string, unknown>,
    cleaned: Record<string, unknown>,
    sourceTimestamp: string,
    source: DataSource,
  ): RecordQuality {
    // Completeness: fraction of fields with non-null values
    const rawKeys = Object.keys(raw);
    const nonNullCount = rawKeys.filter(
      (k) => raw[k] !== null && raw[k] !== undefined && raw[k] !== '',
    ).length;
    const completeness = rawKeys.length > 0 ? nonNullCount / rawKeys.length : 0;

    // Freshness: how recent is the data relative to the refresh interval
    const ageMs = Math.max(0, Date.now() - new Date(sourceTimestamp).getTime());
    const refreshInterval = source.refreshIntervalMs ?? 60_000;
    const freshness = Math.max(0, 1 - ageMs / (refreshInterval * 5));

    // Consistency: type coherence check (numeric fields remain numeric, strings are non-empty)
    let consistentFields = 0;
    let totalChecked = 0;
    for (const [key, value] of Object.entries(cleaned)) {
      if (key.startsWith('_')) continue; // skip enrichment fields
      totalChecked++;
      if (typeof value === 'number') {
        consistentFields += Number.isFinite(value) ? 1 : 0;
      } else if (typeof value === 'string') {
        consistentFields += value.length > 0 ? 1 : 0;
      } else if (typeof value === 'boolean' || value === null) {
        consistentFields += 1;
      } else if (typeof value === 'object') {
        consistentFields += 1; // objects/arrays are valid
      }
    }
    const consistency = totalChecked > 0 ? consistentFields / totalChecked : 1;

    const overall =
      completeness * QUALITY_WEIGHTS.completeness +
      freshness * QUALITY_WEIGHTS.freshness +
      consistency * QUALITY_WEIGHTS.consistency;

    return {
      completeness: Number(completeness.toFixed(4)),
      freshness: Number(Math.max(0, Math.min(1, freshness)).toFixed(4)),
      consistency: Number(consistency.toFixed(4)),
      overall: Number(Math.max(0, Math.min(1, overall)).toFixed(4)),
    };
  }

  // ─── Time-Series Query ────────────────────────────────────────────────

  query(params: z.infer<typeof querySchema>): NormalizedRecord[] {
    const limit = params.limit ?? 100;
    let allRecords: NormalizedRecord[] = [];

    if (params.sourceId) {
      allRecords = this.records.get(params.sourceId) ?? [];
    } else {
      for (const recs of this.records.values()) {
        allRecords = allRecords.concat(recs);
      }
    }

    // Filter by dataType
    if (params.dataType) {
      allRecords = allRecords.filter((r) => r.dataType === params.dataType);
    }

    // Filter by time range
    if (params.from) {
      const fromTs = new Date(params.from).getTime();
      allRecords = allRecords.filter(
        (r) => new Date(r.sourceTimestamp).getTime() >= fromTs,
      );
    }

    if (params.to) {
      const toTs = new Date(params.to).getTime();
      allRecords = allRecords.filter(
        (r) => new Date(r.sourceTimestamp).getTime() <= toTs,
      );
    }

    // Sort newest first, limit
    allRecords.sort(
      (a, b) => new Date(b.sourceTimestamp).getTime() - new Date(a.sourceTimestamp).getTime(),
    );

    return allRecords.slice(0, limit).map((r) => structuredClone(r));
  }

  // ─── Quality Report ───────────────────────────────────────────────────

  getQualityReport(sourceId?: string): DataQualityReport[] {
    const sourceIds = sourceId ? [sourceId] : Array.from(this.sources.keys());
    const reports: DataQualityReport[] = [];

    for (const sid of sourceIds) {
      const recs = this.records.get(sid) ?? [];
      if (recs.length === 0) {
        reports.push({
          sourceId: sid,
          totalRecords: 0,
          avgCompleteness: 0,
          avgFreshness: 0,
          avgConsistency: 0,
          avgOverall: 0,
          generatedAt: isoNow(),
        });
        continue;
      }

      const sumC = recs.reduce((s, r) => s + r.quality.completeness, 0);
      const sumF = recs.reduce((s, r) => s + r.quality.freshness, 0);
      const sumK = recs.reduce((s, r) => s + r.quality.consistency, 0);
      const sumO = recs.reduce((s, r) => s + r.quality.overall, 0);
      const n = recs.length;

      const sorted = [...recs].sort(
        (a, b) => new Date(a.sourceTimestamp).getTime() - new Date(b.sourceTimestamp).getTime(),
      );

      reports.push({
        sourceId: sid,
        totalRecords: n,
        avgCompleteness: Number((sumC / n).toFixed(4)),
        avgFreshness: Number((sumF / n).toFixed(4)),
        avgConsistency: Number((sumK / n).toFixed(4)),
        avgOverall: Number((sumO / n).toFixed(4)),
        oldestRecord: sorted[0].sourceTimestamp,
        newestRecord: sorted[sorted.length - 1].sourceTimestamp,
        generatedAt: isoNow(),
      });
    }

    return reports;
  }

  // ─── Subscription System ──────────────────────────────────────────────

  subscribe(input: z.infer<typeof subscribeSchema>): DataSubscription {
    // Check for duplicate subscriptions
    for (const sub of this.subscriptions.values()) {
      if (sub.agentId === input.agentId && sub.sourceId === input.sourceId && sub.dataType === input.dataType) {
        return structuredClone(sub);
      }
    }

    const subscription: DataSubscription = {
      id: genId('sub'),
      agentId: input.agentId,
      sourceId: input.sourceId,
      dataType: input.dataType,
      filter: input.filter,
      createdAt: isoNow(),
      deliveredCount: 0,
    };

    this.subscriptions.set(subscription.id, subscription);

    eventBus.emit('data.subscribed', {
      subscriptionId: subscription.id,
      agentId: input.agentId,
      sourceId: input.sourceId,
    });

    return structuredClone(subscription);
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  listSubscriptions(agentId?: string): DataSubscription[] {
    const subs = Array.from(this.subscriptions.values());
    const filtered = agentId ? subs.filter((s) => s.agentId === agentId) : subs;
    return filtered.map((s) => structuredClone(s));
  }

  private deliverToSubscribers(record: NormalizedRecord): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.sourceId !== record.sourceId) continue;
      if (sub.dataType && sub.dataType !== record.dataType) continue;

      // Check filter match
      if (sub.filter) {
        const matches = Object.entries(sub.filter).every(([key, value]) => {
          return record.cleaned[key] === value || record.enriched[key] === value;
        });
        if (!matches) continue;
      }

      sub.deliveredCount += 1;
      sub.lastDeliveredAt = isoNow();

      eventBus.emit('data.delivered', {
        subscriptionId: sub.id,
        agentId: sub.agentId,
        recordId: record.id,
      });
    }
  }

  // ─── Derived Metrics Engine ───────────────────────────────────────────

  registerMetric(input: z.infer<typeof metricDefinitionSchema>): MetricDefinition {
    const definition: MetricDefinition = {
      id: input.id,
      name: input.name,
      sourceId: input.sourceId,
      dataType: input.dataType,
      aggregation: input.aggregation,
      field: input.field,
      windowMs: input.windowMs ?? DEFAULT_METRIC_WINDOW_MS,
      createdAt: isoNow(),
    };

    this.metrics.set(definition.id, definition);
    return structuredClone(definition);
  }

  computeMetric(metricId: string): MetricResult | null {
    const def = this.metrics.get(metricId);
    if (!def) return null;

    const cutoff = Date.now() - def.windowMs;
    const recs = (this.records.get(def.sourceId) ?? []).filter((r) => {
      if (r.dataType !== def.dataType) return false;
      return new Date(r.sourceTimestamp).getTime() >= cutoff;
    });

    const values: number[] = [];
    for (const rec of recs) {
      const val = rec.cleaned[def.field] ?? rec.enriched[def.field];
      if (typeof val === 'number' && Number.isFinite(val)) {
        values.push(val);
      }
    }

    let value: number | null = null;

    if (values.length > 0) {
      switch (def.aggregation) {
        case 'avg':
          value = values.reduce((a, b) => a + b, 0) / values.length;
          break;
        case 'sum':
          value = values.reduce((a, b) => a + b, 0);
          break;
        case 'min':
          value = Math.min(...values);
          break;
        case 'max':
          value = Math.max(...values);
          break;
        case 'count':
          value = values.length;
          break;
        case 'last':
          value = values[values.length - 1];
          break;
        case 'first':
          value = values[0];
          break;
        case 'stddev': {
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
          value = Math.sqrt(variance);
          break;
        }
      }
    }

    return {
      metricId: def.id,
      name: def.name,
      value: value !== null ? Number(value.toFixed(6)) : null,
      sampleCount: values.length,
      windowMs: def.windowMs,
      computedAt: isoNow(),
    };
  }

  computeAllMetrics(): MetricResult[] {
    const results: MetricResult[] = [];
    for (const metricId of this.metrics.keys()) {
      const result = this.computeMetric(metricId);
      if (result) results.push(result);
    }
    return results;
  }

  listMetricDefinitions(): MetricDefinition[] {
    return Array.from(this.metrics.values()).map((m) => structuredClone(m));
  }

  // ─── Retention Management ─────────────────────────────────────────────

  private applyRetention(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;

    const recs = this.records.get(sourceId);
    if (!recs || recs.length === 0) return;

    const cutoff = Date.now() - source.retentionMs;
    const beforeCount = recs.length;

    // Remove records older than retention
    const filtered = recs.filter(
      (r) => new Date(r.ingestedAt).getTime() >= cutoff,
    );

    if (filtered.length < beforeCount) {
      this.records.set(sourceId, filtered);
    }
  }

  /**
   * Force a retention sweep across all sources.
   */
  sweepRetention(): { swept: number } {
    let totalSwept = 0;
    for (const sourceId of this.sources.keys()) {
      const before = (this.records.get(sourceId) ?? []).length;
      this.applyRetention(sourceId);
      const after = (this.records.get(sourceId) ?? []).length;
      totalSwept += before - after;
    }
    return { swept: totalSwept };
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  getStats(): {
    totalSources: number;
    totalRecords: number;
    totalSubscriptions: number;
    totalMetrics: number;
    recordsBySource: Record<string, number>;
  } {
    const recordsBySource: Record<string, number> = {};
    let totalRecords = 0;
    for (const [sid, recs] of this.records) {
      recordsBySource[sid] = recs.length;
      totalRecords += recs.length;
    }

    return {
      totalSources: this.sources.size,
      totalRecords,
      totalSubscriptions: this.subscriptions.size,
      totalMetrics: this.metrics.size,
      recordsBySource,
    };
  }
}
