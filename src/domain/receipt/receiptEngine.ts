import { ExecutionRecord, ExecutionReceipt } from '../../types.js';
import { hashObject, sha256Hex } from '../../utils/hash.js';

const RECEIPT_VERSION: ExecutionReceipt['version'] = 'v1';
const SIGNATURE_SCHEME: ExecutionReceipt['signaturePayload']['scheme'] = 'colosseum-receipt-signature-v1';

const receiptPayload = (execution: ExecutionRecord): ExecutionReceipt['payload'] => ({
  executionId: execution.id,
  intentId: execution.intentId,
  agentId: execution.agentId,
  symbol: execution.symbol,
  side: execution.side,
  quantity: execution.quantity,
  priceUsd: execution.priceUsd,
  grossNotionalUsd: execution.grossNotionalUsd,
  feeUsd: execution.feeUsd,
  netUsd: execution.netUsd,
  realizedPnlUsd: execution.realizedPnlUsd,
  pnlSnapshotUsd: execution.pnlSnapshotUsd,
  mode: execution.mode,
  status: execution.status,
  failureReason: execution.failureReason,
  txSignature: execution.txSignature,
  timestamp: execution.createdAt,
});

const receiptMessage = (
  version: ExecutionReceipt['version'],
  payloadHash: string,
  prevReceiptHash?: string,
): string => `${version}|${payloadHash}|${prevReceiptHash ?? 'GENESIS'}`;

export class ReceiptEngine {
  createReceipt(execution: ExecutionRecord, prevReceiptHash?: string): ExecutionReceipt {
    const payload = receiptPayload(execution);
    const payloadHash = hashObject(payload);
    const message = receiptMessage(RECEIPT_VERSION, payloadHash, prevReceiptHash);
    const receiptHash = sha256Hex(message);

    return {
      version: RECEIPT_VERSION,
      executionId: execution.id,
      payload,
      payloadHash,
      prevReceiptHash,
      receiptHash,
      signaturePayload: {
        scheme: SIGNATURE_SCHEME,
        message,
        messageHash: receiptHash,
      },
      createdAt: execution.createdAt,
    };
  }

  verifyReceipt(execution: ExecutionRecord, receipt: ExecutionReceipt): {
    ok: boolean;
    expectedPayloadHash: string;
    expectedReceiptHash: string;
    expectedSignaturePayloadHash: string;
  } {
    const expectedPayloadHash = hashObject(receiptPayload(execution));
    const expectedMessage = receiptMessage(receipt.version, expectedPayloadHash, receipt.prevReceiptHash);
    const expectedReceiptHash = sha256Hex(expectedMessage);
    const expectedSignaturePayloadHash = hashObject({
      scheme: SIGNATURE_SCHEME,
      message: expectedMessage,
      messageHash: expectedReceiptHash,
    });

    const receivedPayloadHash = hashObject(receipt.payload);
    const receivedSignaturePayloadHash = hashObject(receipt.signaturePayload);

    const ok = receipt.payloadHash === expectedPayloadHash
      && receipt.payloadHash === receivedPayloadHash
      && receipt.receiptHash === expectedReceiptHash
      && receipt.signaturePayload.message === expectedMessage
      && receipt.signaturePayload.messageHash === receipt.receiptHash
      && receivedSignaturePayloadHash === expectedSignaturePayloadHash;

    return {
      ok,
      expectedPayloadHash,
      expectedReceiptHash,
      expectedSignaturePayloadHash,
    };
  }
}
