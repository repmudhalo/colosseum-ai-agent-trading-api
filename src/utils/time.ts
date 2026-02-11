export const isoNow = (): string => new Date().toISOString();

export const dayKey = (ts: Date | string = new Date()): string => {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
};
