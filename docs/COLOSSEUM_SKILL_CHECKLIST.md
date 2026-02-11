# Colosseum skill compliance checklist (v3)

Mapped against: `https://colosseum.com/agent-hackathon/skill.md`

## Project requirements

- [ ] Public GitHub repo required
  - **Blocked (external):** GitHub auth/repo publication pending.
- [x] Solana integration described
- [x] Demo assets prepared (`docs/JUDGES.md`, `scripts/demo-judge.sh`)

## Competitive-gap upgrades

- [x] Verifiable execution receipts (`/executions/:executionId/receipt`, `/receipts/verify/:executionId`)
- [x] Risk telemetry endpoint (`/agents/:agentId/risk`, `/agents/:agentId/risk-telemetry`)
- [x] Strategy plugins (momentum + mean-reversion, switchable per agent)

## Production hardening

- [x] Idempotency keys for trade intents
- [x] Retry/backoff on quote path
- [x] Validation + structured error taxonomy

## Monetization

- [x] x402 policy file (`config/x402-policy.json`)
- [x] Paid-plan enforcement hook (`src/services/paymentGate.ts`)
- [x] Policy endpoint (`/paid-plan/policy`)

## Skill workflow artifacts

- [x] Create/update/submit flow documented (`docs/COLOSSEUM_WORKFLOW.md`)
- [x] Forum cadence documented
- [x] Vote policy note documented
- [x] Heartbeat integration notes documented (`docs/HEARTBEAT_INTEGRATION_NOTES.md`)

## Remaining blockers (only external auth/publication)

1. Push repo to GitHub
2. Ensure repo is public
3. Update Colosseum project `repoLink`
4. Submit final project
