import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config.js';
import { ErrorCode, toErrorEnvelope } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { findPaidEndpoint, X402Policy } from './x402Policy.js';

export const x402PaymentGate = (
  config: AppConfig['payments'],
  store: StateStore,
  policy: X402Policy,
) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.x402Enabled) return;

    // Never gate health or root so load balancers and probes always get 200.
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path === '/health' || path === '/') return;

    const paidEndpoint = findPaidEndpoint(policy, request.method, request.url);
    if (!paidEndpoint) return;

    const proofHeader = (request.headers['x402-proof'] ?? request.headers['x-payment-proof']) as string | undefined;
    const ok = await verifyProof(proofHeader, config.x402VerifierUrl);

    if (ok) return;

    await store.transaction((state) => {
      state.metrics.apiPaymentDenials += 1;
      return undefined;
    });

    reply.code(402).send({
      ...toErrorEnvelope(
        ErrorCode.PaymentRequired,
        'Missing or invalid x402 payment proof. Supply x402-proof header.',
      ),
      protocol: 'x402',
      acceptedHeaders: ['x402-proof', 'x-payment-proof'],
      verifyEndpoint: config.x402VerifierUrl ?? null,
      requiredPlan: paidEndpoint.plan,
      endpointPolicy: {
        method: paidEndpoint.method,
        pathPrefix: paidEndpoint.pathPrefix,
      },
      policyVersion: policy.version,
    });
  };
};

async function verifyProof(proof: string | undefined, verifierUrl?: string): Promise<boolean> {
  if (!proof || proof.length < 10) {
    return false;
  }

  if (!verifierUrl) {
    return true;
  }

  const response = await fetch(verifierUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proof }),
  }).catch(() => undefined);

  if (!response || !response.ok) return false;

  const json = (await response.json().catch(() => ({}))) as { valid?: boolean };
  return Boolean(json.valid);
}
