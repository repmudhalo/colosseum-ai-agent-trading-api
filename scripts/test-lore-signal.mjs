#!/usr/bin/env node
/**
 * Send a test LORE webhook signal to the bot.
 *
 * Usage:
 *   node scripts/test-lore-signal.mjs                          # localhost:8787
 *   node scripts/test-lore-signal.mjs https://your-app.railway.app
 *   node scripts/test-lore-signal.mjs https://your-app.railway.app Gamble
 *
 * Args:
 *   1. Base URL     (default: http://localhost:8787)
 *   2. Box type     (default: Fastest)  — Gamble, Fastest, or Highest
 *   3. Event type   (default: token_featured)
 *   4. Mint address (default: a well-known test mint)
 */

import crypto from 'node:crypto';

const BASE_URL = process.argv[2] || 'http://localhost:8787';
const BOX_TYPE = process.argv[3] || 'Fastest';
const EVENT    = process.argv[4] || 'token_featured';
const MINT     = process.argv[5] || '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'; // POPCAT

// Read webhook secret from env or hardcode for testing.
const SECRET = process.env.LORE_WEBHOOK_SECRET
  || 'whsec_99a223972cdc568f7801ec969463dc32013db671d7a3a938f1ded8d7733a1dfc';

const payload = {
  event: EVENT,
  timestamp: new Date().toISOString(),
  data: {
    boxType: BOX_TYPE,
    token: {
      address: MINT,
      symbol: 'POPCAT',
      name: 'Popcat',
      mc: 500_000_000,
    },
    volume24h: 12_345_678,
    holders: 54321,
  },
};

const body = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

console.log('─── Test LORE Signal ───');
console.log(`URL:       ${BASE_URL}/webhooks/lore`);
console.log(`Event:     ${EVENT}`);
console.log(`Box:       ${BOX_TYPE}`);
console.log(`Mint:      ${MINT}`);
console.log(`Signature: ${signature.slice(0, 16)}...`);
console.log('');

try {
  const res = await fetch(`${BASE_URL}/webhooks/lore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LORE-Signature': signature,
      'X-LORE-Event': EVENT,
      'X-LORE-Timestamp': payload.timestamp,
      'X-LORE-Subscriber': 'test-script',
    },
    body,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  console.log(`Status:    ${res.status} ${res.statusText}`);
  console.log('Response:', JSON.stringify(json, null, 2));

  if (res.status === 200) {
    console.log('\n✓ Signal delivered successfully.');
    console.log('  Check your dashboard LORE feed and logs (data/events.ndjson) for processing details.');
  } else {
    console.log('\n✗ Signal was NOT accepted. See response above.');
  }
} catch (err) {
  console.error('Fetch error:', err.message);
  console.log('\nMake sure the server is running at', BASE_URL);
}
