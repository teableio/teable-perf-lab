import type { BenchOperationMeasurement, BenchOperationObservation } from './BenchRunner';
import { percentileResolutionWarnings, summarize } from './metrics';

export type OperationStats = {
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
  readonly rowsReturned?: number;
  readonly processed?: number;
  readonly observation?: BenchOperationObservation;
};

export type TimedOperationResult<T> = {
  readonly data: T;
  readonly latencyMs: number;
};

export type OperationResult<T> = TimedOperationResult<T> & OperationStats;

export type MutableMeasurement<K extends string = string> = {
  key: K;
  kind: BenchOperationMeasurement['kind'];
  samplesMs: number[];
  rowsRead: number;
  rowsWritten: number;
  rowsReturned: number;
  processed: number;
  errors: number;
  warnings: string[];
  observation?: BenchOperationObservation;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export class RecordedBenchFailure extends Error {}

export class RecordedOperationFailure extends RecordedBenchFailure {
  constructor(
    readonly key: string,
    readonly causeValue: unknown
  ) {
    super(`${key}: ${errorMessage(causeValue)}`);
    this.name = 'RecordedOperationFailure';
  }
}

export const makeMeasurements = <K extends string>(
  cases: ReadonlyArray<{ readonly key: K; readonly kind: BenchOperationMeasurement['kind'] }>
): Map<K, MutableMeasurement<K>> =>
  new Map(
    cases.map(({ key, kind }) => [
      key,
      {
        key,
        kind,
        samplesMs: [],
        rowsRead: 0,
        rowsWritten: 0,
        rowsReturned: 0,
        processed: 0,
        errors: 0,
        warnings: [],
      },
    ])
  );

export const mergeObservation = (
  current: BenchOperationObservation | undefined,
  incoming: BenchOperationObservation | undefined
): BenchOperationObservation | undefined => {
  if (!incoming) return current;
  if (!current) return incoming;
  const recordIds = [...new Set([...current.recordIds, ...incoming.recordIds])].slice(0, 100);
  return {
    recordIds,
    recordRelation:
      incoming.recordRelation === 'none' ? current.recordRelation : incoming.recordRelation,
    fieldNames: [...new Set([...current.fieldNames, ...incoming.fieldNames])],
    truncated:
      current.truncated ||
      incoming.truncated ||
      current.recordIds.length + incoming.recordIds.length > 100,
  };
};

/** Query summaries replace the prior relation unconditionally. */
export const mergeObservationReplacingRelation = (
  current: BenchOperationObservation | undefined,
  incoming: BenchOperationObservation | undefined
): BenchOperationObservation | undefined => {
  if (!incoming) return current;
  if (!current) return incoming;
  const recordIds = [...new Set([...current.recordIds, ...incoming.recordIds])].slice(0, 100);
  return {
    recordIds,
    recordRelation: incoming.recordRelation,
    fieldNames: [...new Set([...current.fieldNames, ...incoming.fieldNames])],
    truncated:
      current.truncated ||
      incoming.truncated ||
      current.recordIds.length + incoming.recordIds.length > 100,
  };
};

const finalize = (
  measurement: MutableMeasurement,
  warnings: ReadonlyArray<string>
): BenchOperationMeasurement => {
  const common = { ...measurement, warnings };
  if (measurement.samplesMs.length === 0) {
    return {
      ...common,
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      meanMs: null,
    };
  }
  return { ...common, ...summarize(measurement.samplesMs) };
};

export const finalizeMeasurement = (measurement: MutableMeasurement): BenchOperationMeasurement => {
  const warnings = [
    ...measurement.warnings,
    ...percentileResolutionWarnings(measurement.samplesMs.length).filter(
      (warning) => !measurement.warnings.includes(warning)
    ),
  ];
  return finalize(measurement, warnings);
};

/** Field transitions report only resolution warnings, not caller-supplied warnings. */
export const finalizeMeasurementReplacingWarnings = (
  measurement: MutableMeasurement
): BenchOperationMeasurement =>
  finalize(measurement, percentileResolutionWarnings(measurement.samplesMs.length));

export const recordMeasuredResult = <K extends string>(
  measurement: MutableMeasurement<K>,
  measured: boolean,
  result: OperationStats & { readonly latencyMs: number }
): void => {
  if (!measured) return;
  measurement.samplesMs.push(result.latencyMs);
  measurement.rowsRead += result.rowsRead ?? 0;
  measurement.rowsWritten += result.rowsWritten ?? 0;
  measurement.rowsReturned += result.rowsReturned ?? 0;
  measurement.processed += result.processed ?? 0;
  if (result.observation) {
    measurement.observation = mergeObservation(measurement.observation, result.observation);
  }
};

export const recordOperationFailure = <K extends string>(
  measurement: MutableMeasurement<K>,
  errors: string[],
  key: K,
  causeValue: unknown
): RecordedOperationFailure => {
  measurement.errors += 1;
  const failure = new RecordedOperationFailure(key, causeValue);
  errors.push(failure.message);
  return failure;
};

const execute = async <T, K extends string>(
  input: {
    readonly key: K;
    readonly measured: boolean;
    readonly measurements: Map<K, MutableMeasurement<K>>;
    readonly errors: string[];
    readonly action: () => Promise<OperationResult<T>>;
  },
  merge: (
    current: BenchOperationObservation | undefined,
    incoming: BenchOperationObservation | undefined
  ) => BenchOperationObservation | undefined
): Promise<T> => {
  const measurement = input.measurements.get(input.key);
  if (!measurement) throw new Error(`Missing measurement for ${input.key}`);
  try {
    const result = await input.action();
    if (input.measured) {
      measurement.samplesMs.push(result.latencyMs);
      measurement.rowsRead += result.rowsRead ?? 0;
      measurement.rowsWritten += result.rowsWritten ?? 0;
      measurement.rowsReturned += result.rowsReturned ?? 0;
      measurement.processed += result.processed ?? 0;
      if (result.observation) {
        measurement.observation = merge(measurement.observation, result.observation);
      }
    }
    return result.data;
  } catch (error) {
    throw recordOperationFailure(measurement, input.errors, input.key, error);
  }
};

export const executeMeasured = async <T, K extends string>(input: {
  readonly key: K;
  readonly measured: boolean;
  readonly measurements: Map<K, MutableMeasurement<K>>;
  readonly errors: string[];
  readonly action: () => Promise<OperationResult<T>>;
}): Promise<T> => execute(input, mergeObservation);

export const executeMeasuredReplacingRelation = async <T, K extends string>(input: {
  readonly key: K;
  readonly measured: boolean;
  readonly measurements: Map<K, MutableMeasurement<K>>;
  readonly errors: string[];
  readonly action: () => Promise<OperationResult<T>>;
}): Promise<T> => execute(input, mergeObservationReplacingRelation);
