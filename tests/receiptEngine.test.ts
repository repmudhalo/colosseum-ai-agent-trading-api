import { describe, expect, it } from 'vitest';
import { ReceiptEngine } from '../src/domain/receipt/receiptEngine.js';
import { ExecutionRecord } from '../src/types.js';
import { hashObject } from '../src/utils/hash.js';

const baseExecution = (): ExecutionRecord => ({
  id: 'exec-1',
  intentId: 'intent-1',
  agentId: 'agent-1',
  symbol: 'SOL',
  side: 'buy',
  quantity: 1.25,
  priceUsd: 125,
  grossNotionalUsd: 156.25,
  feeUsd: 0.125,
  netUsd: -156.375,
  realizedPnlUsd: 0,
  pnlSnapshotUsd: 0,
  mode: 'paper',
  status: 'filled',
  txSignature: undefined,
  createdAt: '2026-02-11T12:00:00.000Z',
});

describe('ReceiptEngine', () => {
  const engine = new ReceiptEngine();

  it('creates deterministic receipt hash and signature payload', () => {
    const execution = baseExecution();

    const r1 = engine.createReceipt(execution, 'prev-hash-123');
    const r2 = engine.createReceipt(execution, 'prev-hash-123');

    expect(r1).toEqual(r2);
    expect(r1.signaturePayload.message).toBe(`${r1.version}|${r1.payloadHash}|prev-hash-123`);
    expect(r1.signaturePayload.messageHash).toBe(r1.receiptHash);
  });

  it('verifies receipt integrity and signature payload hash', () => {
    const execution = baseExecution();
    const receipt = engine.createReceipt(execution, 'prev-hash-abc');

    const verification = engine.verifyReceipt(execution, receipt);

    expect(verification.ok).toBe(true);
    expect(verification.expectedPayloadHash).toBe(receipt.payloadHash);
    expect(verification.expectedReceiptHash).toBe(receipt.receiptHash);
    expect(verification.expectedSignaturePayloadHash).toBe(hashObject(receipt.signaturePayload));
  });

  it('fails verification when receipt hash metadata is tampered', () => {
    const execution = baseExecution();
    const receipt = engine.createReceipt(execution, 'prev-hash-xyz');

    const tampered = {
      ...receipt,
      payloadHash: `bad-${receipt.payloadHash}`,
    };

    const verification = engine.verifyReceipt(execution, tampered);
    expect(verification.ok).toBe(false);
  });
});
