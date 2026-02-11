import crypto from 'node:crypto';

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, normalize(v)]);

    return Object.fromEntries(entries);
  }

  return value;
};

export const stableStringify = (value: unknown): string => JSON.stringify(normalize(value));

export const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const hashObject = (value: unknown): string => sha256Hex(stableStringify(value));
