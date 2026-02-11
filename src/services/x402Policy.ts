import fs from 'node:fs/promises';

export interface X402PolicyRule {
  method: string;
  pathPrefix: string;
  plan: string;
  description?: string;
}

export interface X402Policy {
  version: string;
  paidEndpoints: X402PolicyRule[];
}

const defaultPolicy = (requiredPaths: string[]): X402Policy => ({
  version: 'fallback-v1',
  paidEndpoints: requiredPaths.map((pathPrefix) => ({
    method: 'POST',
    pathPrefix,
    plan: 'pro',
    description: 'fallback policy route',
  })),
});

export async function loadX402Policy(policyFilePath: string, requiredPaths: string[]): Promise<X402Policy> {
  try {
    const raw = await fs.readFile(policyFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as X402Policy;

    if (!Array.isArray(parsed.paidEndpoints) || typeof parsed.version !== 'string') {
      throw new Error('invalid policy schema');
    }

    return parsed;
  } catch {
    return defaultPolicy(requiredPaths);
  }
}

export const findPaidEndpoint = (
  policy: X402Policy,
  method: string,
  requestUrl: string,
): X402PolicyRule | undefined => {
  const normalizedMethod = method.toUpperCase();
  const urlPath = requestUrl.split('?')[0] ?? requestUrl;

  return policy.paidEndpoints.find((rule) =>
    rule.method.toUpperCase() === normalizedMethod
      && urlPath.startsWith(rule.pathPrefix),
  );
};
