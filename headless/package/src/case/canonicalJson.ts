import { createHash } from 'node:crypto';

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, normalize(entry)])
    );
  }
  return value;
};

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(normalize(value));
  return result === undefined ? 'undefined' : result;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
