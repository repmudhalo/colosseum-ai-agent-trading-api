import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config.js';
import { StateStore } from '../infra/storage/stateStore.js';

export const x402PaymentGate = (config: AppConfig['payments'], store: StateStore) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.x402Enabled) return;

    const shouldGate = config.x402RequiredPaths.some((prefix) => request.url.startsWith(prefix));
    if (!shouldGate) return;

    const proofHeader = (request.headers['x402-proof'] ?? request.headers['x-payment-proof']) as string | undefined;
    const ok = await verifyProof(proofHeader, config.x402VerifierUrl);

    if (ok) return;

    await store.transaction((state) => {
      state.metrics.apiPaymentDenials += 1;
      return undefined;
    });

    reply.code(402).send({
      error: 'payment_required',
      protocol: 'x402',
      message: 'Missing or invalid x402 payment proof. Supply x402-proof header.',
      acceptedHeaders: ['x402-proof', 'x-payment-proof'],
      verifyEndpoint: config.x402VerifierUrl ?? null,
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
