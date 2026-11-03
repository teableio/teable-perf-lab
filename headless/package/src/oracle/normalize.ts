import { canonicalJson } from '../case/canonicalJson';
import { BenchError } from '../errors';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const normalizeDateLike = (value: string): string => {
  if (!ISO_DATE_PATTERN.test(value)) {
    return value;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Date(timestamp).toISOString();
};

export const normalizeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BenchError(
        'bench.oracle.number_nonfinite',
        `Oracle values must be finite numbers, received ${String(value)}`
      );
    }
    return Number(value.toFixed(6));
  }
  if (typeof value === 'string') {
    return normalizeDateLike(value);
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeValue(item));
    return [...normalized].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeValue(value[key]);
    }
    return result;
  }
  return value;
};

export const normalizeRows = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  keys: ReadonlyArray<string>
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const normalized = rows.map((row) => normalizeValue(row) as Readonly<Record<string, unknown>>);

  const seen = new Set<string>();
  for (const row of normalized) {
    const identity = canonicalJson(keys.map((key) => row[key]));
    if (seen.has(identity)) {
      throw new BenchError('bench.oracle.duplicate_key', `Duplicate oracle key ${identity}`);
    }
    seen.add(identity);
  }

  return [...normalized].sort((left, right) => {
    const leftKey = canonicalJson(keys.map((key) => left[key]));
    const rightKey = canonicalJson(keys.map((key) => right[key]));
    return leftKey.localeCompare(rightKey);
  });
};
