# Execution Receipts & Verification

Colosseum produces a deterministic receipt for every execution (filled or failed).

## Receipt structure

`GET /executions/:executionId/receipt` returns:

- `payload`: canonical execution facts (agent, side, quantity, price, fee, PnL snapshot, status)
- `payloadHash`: `sha256(stable_json(payload))`
- `prevReceiptHash`: previous receipt hash in sequence (or `GENESIS` for first)
- `receiptHash`: `sha256("v1|payloadHash|prevReceiptHash_or_GENESIS")`
- `signaturePayload`:
  - `scheme`: `colosseum-receipt-signature-v1`
  - `message`: `v1|payloadHash|prevReceiptHash_or_GENESIS`
  - `messageHash`: equals `receiptHash`

This gives:
1. **Deterministic per-execution proof hash**
2. **Tamper-evident hash chain across executions**
3. **Deterministic signable payload** for external signing workflows

## Verify via API

```bash
curl -s http://localhost:8787/receipts/verify/<EXECUTION_ID>
```

`ok: true` means payload hash, receipt hash, and signature payload all match expected deterministic values.

## End-to-end curl example

```bash
# 1) Fetch receipt
curl -s http://localhost:8787/executions/<EXECUTION_ID>/receipt

# 2) Verify deterministic integrity
curl -s http://localhost:8787/receipts/verify/<EXECUTION_ID>
```

## Local deterministic rule (reference)

For any execution `E`:

1. `payload = canonical(E)`
2. `payloadHash = sha256(stable_json(payload))`
3. `message = "v1|" + payloadHash + "|" + (prevReceiptHash ?? "GENESIS")`
4. `receiptHash = sha256(message)`
5. `signaturePayload = { scheme, message, messageHash: receiptHash }`

If any execution field or chain link changes, verification fails.
