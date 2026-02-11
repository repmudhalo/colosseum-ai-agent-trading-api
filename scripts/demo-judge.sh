#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}"

extract_json() {
  local json="$1"
  local path="$2"
  node -e '
const data = JSON.parse(process.argv[1]);
const path = process.argv[2].split(".");
let v = data;
for (const key of path) v = v?.[key];
if (v === undefined) process.exit(2);
process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
' "$json" "$path"
}

poll_intent_terminal() {
  local intent_id="$1"
  local max_tries="${2:-50}"

  for _ in $(seq 1 "$max_tries"); do
    local intent_json
    intent_json="$(curl -s "${BASE}/trade-intents/${intent_id}")"
    local status
    status="$(extract_json "$intent_json" "status")"

    if [[ "$status" == "executed" || "$status" == "rejected" || "$status" == "failed" ]]; then
      echo "$intent_json"
      return 0
    fi

    sleep 0.2
  done

  echo "Intent ${intent_id} did not reach terminal status" >&2
  return 1
}

rm -rf data
mkdir -p data

npm run build >/dev/null
PORT="$PORT" node dist/index.js >/tmp/colosseum-judge-demo.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 1.5

echo "== 1) Register agent (momentum strategy + strict max order) =="
REGISTER_RESPONSE=$(curl -s -X POST "${BASE}/agents/register" \
  -H 'content-type: application/json' \
  -d '{"name":"judge-agent","strategyId":"momentum-v1","riskOverrides":{"maxOrderNotionalUsd":150,"maxPositionSizePct":1,"maxGrossExposureUsd":100000,"dailyLossCapUsd":100000,"maxDrawdownPct":0.95,"cooldownSeconds":0}}')

echo "$REGISTER_RESPONSE"

AGENT_ID="$(extract_json "$REGISTER_RESPONSE" "agent.id")"
API_KEY="$(extract_json "$REGISTER_RESPONSE" "apiKey")"

echo
echo "== 2) Seed market trend so momentum emits BUY =="
for px in 101 102 103 104 105 106; do
  curl -s -X POST "${BASE}/market/prices" \
    -H 'content-type: application/json' \
    -d "{\"symbol\":\"SOL\",\"priceUsd\":${px}}" >/dev/null
done
echo "Price ramped to 106"

echo
echo "== 3) Submit successful BUY intent =="
SUCCESS_INTENT_RESPONSE=$(curl -s -X POST "${BASE}/trade-intents" \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: ${API_KEY}" \
  -H 'x-idempotency-key: judge-success-1' \
  -d "{\"agentId\":\"${AGENT_ID}\",\"symbol\":\"SOL\",\"side\":\"buy\",\"notionalUsd\":80,\"requestedMode\":\"paper\"}")

echo "$SUCCESS_INTENT_RESPONSE"
SUCCESS_INTENT_ID="$(extract_json "$SUCCESS_INTENT_RESPONSE" "intent.id")"

echo
echo "== 4) Submit intentionally risky BUY intent (should reject) =="
RISKY_INTENT_RESPONSE=$(curl -s -X POST "${BASE}/trade-intents" \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: ${API_KEY}" \
  -H 'x-idempotency-key: judge-risky-1' \
  -d "{\"agentId\":\"${AGENT_ID}\",\"symbol\":\"SOL\",\"side\":\"buy\",\"notionalUsd\":300,\"requestedMode\":\"paper\"}")

echo "$RISKY_INTENT_RESPONSE"
RISKY_INTENT_ID="$(extract_json "$RISKY_INTENT_RESPONSE" "intent.id")"

echo
echo "== 5) Wait for execution/rejection outcomes =="
SUCCESS_FINAL="$(poll_intent_terminal "$SUCCESS_INTENT_ID")"
RISKY_FINAL="$(poll_intent_terminal "$RISKY_INTENT_ID")"

echo "Successful intent final state: $SUCCESS_FINAL"
echo "Risky intent final state:      $RISKY_FINAL"

EXECUTION_ID="$(extract_json "$SUCCESS_FINAL" "executionId")"

echo
echo "== 6) Retrieve verifiable receipt for successful execution =="
RECEIPT_JSON="$(curl -s "${BASE}/executions/${EXECUTION_ID}/receipt")"
VERIFY_JSON="$(curl -s "${BASE}/receipts/verify/${EXECUTION_ID}")"

echo "$RECEIPT_JSON"
echo "$VERIFY_JSON"

echo
echo "== 7) Show fee accrual in treasury and risk telemetry =="
METRICS_JSON="$(curl -s "${BASE}/metrics")"
RISK_JSON="$(curl -s "${BASE}/agents/${AGENT_ID}/risk")"

echo "$METRICS_JSON"
echo "$RISK_JSON"

echo
echo "== Demo summary =="
echo "Agent ID: ${AGENT_ID}"
echo "Execution ID: ${EXECUTION_ID}"
echo "Treasury total fees USD: $(extract_json "$METRICS_JSON" "treasury.totalFeesUsd")"
echo "Risk rejection counter max_order_notional_exceeded: $(extract_json "$RISK_JSON" "rejectCountersByReason.max_order_notional_exceeded")"
echo
echo "Done. Server logs: /tmp/colosseum-judge-demo.log"
