import { describe, it, expect } from 'vitest';
import { redactReceipt } from '../src/domain/privacy/receiptRedaction.js';
import { ExecutionReceipt } from '../src/types.js';

const makeReceipt = (overrides: Partial<ExecutionReceipt['payload']> = {}): ExecutionReceipt => ({
  version: 'v1',
  executionId: 'exec-1',
  payload: {
    executionId: 'exec-1',
    intentId: 'intent-1',
    agentId: 'agent-1',
    symbol: 'SOL',
    side: 'buy',
    quantity: 10,
    priceUsd: 100,
    grossNotionalUsd: 1000,
    feeUsd: 8,
    netUsd: 992,
    realizedPnlUsd: 50,
    pnlSnapshotUsd: 50,
    mode: 'paper',
    status: 'filled',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  },
  payloadHash: 'hash-abc',
  prevReceiptHash: 'prev-hash',
  receiptHash: 'receipt-hash',
  signaturePayload: {
    scheme: 'colosseum-receipt-signature-v1',
    message: 'v1|hash-abc|prev-hash',
    messageHash: 'receipt-hash',
  },
  createdAt: '2025-01-01T00:00:00.000Z',
});

describe('Receipt Redaction', () => {
  it('redacts sensitive numeric fields', () => {
    const receipt = makeReceipt();
    const redacted = redactReceipt(receipt);

    expect(redacted.redacted).toBe(true);
    expect(redacted.payload.quantity).toBe('[REDACTED]');
    expect(redacted.payload.priceUsd).toBe('[REDACTED]');
    expect(redacted.payload.grossNotionalUsd).toBe('[REDACTED]');
    expect(redacted.payload.feeUsd).toBe('[REDACTED]');
    expect(redacted.payload.netUsd).toBe('[REDACTED]');
    expect(redacted.payload.realizedPnlUsd).toBe('[REDACTED]');
    expect(redacted.payload.pnlSnapshotUsd).toBe('[REDACTED]');
  });

  it('preserves non-sensitive fields', () => {
    const receipt = makeReceipt();
    const redacted = redactReceipt(receipt);

    expect(redacted.payload.executionId).toBe('exec-1');
    expect(redacted.payload.intentId).toBe('intent-1');
    expect(redacted.payload.agentId).toBe('agent-1');
    expect(redacted.payload.symbol).toBe('SOL');
    expect(redacted.payload.side).toBe('buy');
    expect(redacted.payload.mode).toBe('paper');
    expect(redacted.payload.status).toBe('filled');
    expect(redacted.payload.timestamp).toBe('2025-01-01T00:00:00.000Z');
  });

  it('produces a different hash from the original', () => {
    const receipt = makeReceipt();
    const redacted = redactReceipt(receipt);

    expect(redacted.receiptHash).toBeDefined();
    expect(redacted.receiptHash).not.toBe(receipt.receiptHash);
    expect(redacted.payloadHash).not.toBe(receipt.payloadHash);
  });

  it('includes the redaction flag in the hash computation', () => {
    const receipt = makeReceipt();
    const r1 = redactReceipt(receipt);
    const r2 = redactReceipt(receipt);

    // Same receipt should produce the same redacted hash
    expect(r1.receiptHash).toBe(r2.receiptHash);
    expect(r1.payloadHash).toBe(r2.payloadHash);
  });

  it('preserves prevReceiptHash for chain continuity', () => {
    const receipt = makeReceipt();
    const redacted = redactReceipt(receipt);

    expect(redacted.prevReceiptHash).toBe('prev-hash');
    expect(redacted.version).toBe('v1');
    expect(redacted.executionId).toBe('exec-1');
  });
});
