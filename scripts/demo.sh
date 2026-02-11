#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}"

rm -rf data
mkdir -p data

npm run build >/dev/null
node dist/index.js >/tmp/agent-trading-demo.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 2

echo "== Register agent =="
REGISTER_RESPONSE=$(curl -s -X POST "${BASE}/agents/register" \
  -H 'content-type: application/json' \
  -d '{"name":"demo-agent"}')

echo "$REGISTER_RESPONSE"

AGENT_ID=$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.agent.id)" "$REGISTER_RESPONSE")
API_KEY=$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.apiKey)" "$REGISTER_RESPONSE")

echo "\n== Set market price =="
curl -s -X POST "${BASE}/market/prices" \
  -H 'content-type: application/json' \
  -d '{"symbol":"SOL","priceUsd":125.5}'
echo

echo "\n== Submit BUY intent =="
curl -s -X POST "${BASE}/trade-intents" \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: ${API_KEY}" \
  -d "{\"agentId\":\"${AGENT_ID}\",\"symbol\":\"SOL\",\"side\":\"buy\",\"notionalUsd\":500,\"requestedMode\":\"paper\"}"
echo

sleep 2

echo "\n== Submit SELL intent =="
curl -s -X POST "${BASE}/trade-intents" \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: ${API_KEY}" \
  -d "{\"agentId\":\"${AGENT_ID}\",\"symbol\":\"SOL\",\"side\":\"sell\",\"notionalUsd\":120,\"requestedMode\":\"paper\"}"
echo

sleep 2

echo "\n== Portfolio =="
curl -s "${BASE}/agents/${AGENT_ID}/portfolio"
echo

echo "\n== Metrics =="
curl -s "${BASE}/metrics"
echo

echo "\nDemo complete. Raw server logs: /tmp/agent-trading-demo.log"
