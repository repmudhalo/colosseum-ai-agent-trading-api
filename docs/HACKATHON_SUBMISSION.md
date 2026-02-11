# Hackathon Submission Notes

## Project

**Colosseum AI Agent Trading API**

## Problem Statement

AI agents need a programmable trading stack that is:
- autonomous by design
- safe by default
- monetizable for operators

Most current APIs miss one or more of these.

## Solution Summary

This MVP provides an agent-native trading API with:

- agent registration + API keys
- async trade intents
- autonomous execution worker
- policy-enforced risk engine
- paper mode default + gated live mode
- protocol-aware fee monetization
- x402 payment integration point
- persistent operational state and logs

## Solana/Jupiter Integration

- Uses Jupiter v6 quote/swap API endpoints for live flow.
- Supports `platformFeeBps` and optional `feeAccount` for referral monetization.
- Live flow is intentionally gated by env vars for safety.
- Can sign + broadcast swap tx if RPC + key are configured and broadcast is explicitly enabled.

## Autonomy & Safety Design

- Worker loop continuously processes queued intents.
- Every intent must pass risk checks before execution.
- Rejections are explicit and auditable (`statusReason`, metrics, logs).
- Graceful shutdown persists latest state.

## Fee Monetization Model

1. Execution-fee accounting:
   - Fee (bps) deducted per fill, captured in treasury.
2. Jupiter referral path:
   - `platformFeeBps` + referral `feeAccount` plumbing.
3. x402 gate stub:
   - Optional HTTP 402 for paid API routes.

## Demo Plan

1. Register agent
2. Set SOL price
3. Submit buy intent (paper)
4. Submit sell intent (paper)
5. Query portfolio and metrics
6. Show treasury fee accumulation
7. Submit an intentionally unsafe order to show risk rejection

## Why this is hackathon-relevant

- Demonstrates an agent-focused product, not just a bot script.
- Uses Solana ecosystem routing (Jupiter) with monetization hooks.
- Can become infrastructure for many AI trader agents.
