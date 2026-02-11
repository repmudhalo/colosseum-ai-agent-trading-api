export type Side = 'buy' | 'sell';
export type IntentStatus = 'pending' | 'processing' | 'executed' | 'rejected' | 'failed';
export type ExecutionMode = 'paper' | 'live';

export interface RiskLimits {
  maxPositionSizePct: number;
  maxOrderNotionalUsd: number;
  maxGrossExposureUsd: number;
  dailyLossCapUsd: number;
  maxDrawdownPct: number;
  cooldownSeconds: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgEntryPriceUsd: number;
}

export interface Agent {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
  startingCapitalUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  peakEquityUsd: number;
  riskLimits: RiskLimits;
  positions: Record<string, Position>;
  dailyRealizedPnlUsd: Record<string, number>;
  lastTradeAt?: string;
}

export interface TradeIntent {
  id: string;
  agentId: string;
  symbol: string;
  side: Side;
  quantity?: number;
  notionalUsd?: number;
  requestedMode?: ExecutionMode;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: IntentStatus;
  statusReason?: string;
  executionId?: string;
}

export interface ExecutionRecord {
  id: string;
  intentId: string;
  agentId: string;
  symbol: string;
  side: Side;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  feeUsd: number;
  netUsd: number;
  realizedPnlUsd: number;
  mode: ExecutionMode;
  status: 'filled' | 'failed';
  failureReason?: string;
  txSignature?: string;
  createdAt: string;
}

export interface TreasuryEntry {
  id: string;
  source: 'execution-fee' | 'api-payment';
  amountUsd: number;
  refId: string;
  createdAt: string;
  notes?: string;
}

export interface TreasuryState {
  totalFeesUsd: number;
  entries: TreasuryEntry[];
}

export interface RiskDecision {
  approved: boolean;
  reason?: string;
  computedNotionalUsd: number;
  computedQuantity: number;
}

export interface MetricsState {
  startedAt: string;
  workerLoops: number;
  intentsReceived: number;
  intentsExecuted: number;
  intentsRejected: number;
  intentsFailed: number;
  riskRejectionsByReason: Record<string, number>;
  lastWorkerRunAt?: string;
  apiPaymentDenials: number;
}

export interface AppState {
  agents: Record<string, Agent>;
  tradeIntents: Record<string, TradeIntent>;
  executions: Record<string, ExecutionRecord>;
  treasury: TreasuryState;
  marketPricesUsd: Record<string, number>;
  metrics: MetricsState;
}

export interface RuntimeMetrics {
  uptimeSeconds: number;
  pendingIntents: number;
  processPid: number;
}
