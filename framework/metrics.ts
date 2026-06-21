import { performance } from "node:perf_hooks";

export const roundMetric = (value: number) => Number(value.toFixed(2));

export const percentile = (sortedValues: number[], quantile: number) => {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * quantile) - 1,
  );
  return sortedValues[index] ?? 0;
};

export const summarizeDurations = (durations: number[]) => {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    minMs: roundMetric(sorted[0] ?? 0),
    p50Ms: roundMetric(percentile(sorted, 0.5)),
    p95Ms: roundMetric(percentile(sorted, 0.95)),
    maxMs: roundMetric(sorted[sorted.length - 1] ?? 0),
  };
};

// A named, timed async result. This is exactly what `measureAsync` returns,
// and the shape every runner threads through its phases. It lives here, next
// to `measureAsync`, so callers import it from the module that produces it —
// not from an unrelated runner file.
export type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

// The `any` default keeps inference stable when the callback's return type
// degrades to `any` (e.g. under the standalone type check's module stubs);
// without it, TS infers `unknown` for T.
export const measureAsync = async <T = any>(
  name: string,
  fn: () => Promise<T>,
): Promise<Measurement<T>> => {
  const startedAt = performance.now();
  const result = await fn();
  return {
    name,
    durationMs: roundMetric(performance.now() - startedAt),
    result,
  };
};
