import { z } from 'zod';

import type { BenchOperationMeasurement, BenchRunReport } from '../runner/BenchRunner';
import { minimumSamplesForPercentileResolution } from '../runner/metrics';

export const BUDGETS_SCHEMA_VERSION = 'tea-bench-budgets/2' as const;

const OperationBudgetSchema = z
  .object({
    maxP95Ms: z.number().finite().positive(),
    weight: z.number().finite().positive().optional(),
  })
  .strict();
const CaseBudgetSchema = z
  .object({
    ruleId: z.string().min(1),
    caseId: z.string().min(1),
    maxP95Ms: z.number().finite().positive(),
    operations: z.record(z.string().min(1), OperationBudgetSchema),
  })
  .strict();

const MeasurementProtocolSchema = z
  .object({
    version: z.number().int().positive(),
    warmupStrategy: z.string().trim().min(1),
    timingScope: z.string().trim().min(1),
    statistic: z.string().trim().min(1),
  })
  .strict();

export type BudgetMeasurement = {
  readonly measurementProtocol: z.infer<typeof MeasurementProtocolSchema>;
  readonly warmup: number;
  readonly repetitions: number;
  readonly samples: number;
};

export const BenchBudgetsSchema = z
  .object({
    schema: z.literal(BUDGETS_SCHEMA_VERSION),
    headroom: z.number().finite().positive(),
    /** Declared timing floor applied to every operation budget. */
    floorMs: z.number().finite().positive(),
    provenance: z
      .object({
        source: z.string().trim().min(1),
        backend: z.string().trim().min(1),
        measurementProtocol: MeasurementProtocolSchema,
        warmup: z.number().int().nonnegative(),
        repetitions: z.number().int().positive(),
        samples: z.number().int().positive(),
        calibratedAt: z.string().trim().min(1),
      })
      .strict(),
    cases: z.record(z.string().min(1), CaseBudgetSchema),
  })
  .strict();

export type BenchBudgets = z.infer<typeof BenchBudgetsSchema>;
export type BenchManifestPerformancePolicy = {
  readonly modelVersion: 'tea-bench-budget/1';
  readonly source: string;
  readonly maxP95Ms: number;
  readonly operations: Readonly<
    Record<string, { readonly maxP95Ms: number; readonly weight?: number }>
  >;
};

/**
 * Sub-millisecond p95 values are dominated by timer and scheduler noise, so a budget
 * below this floor cannot distinguish a regression from jitter. Operations faster than
 * the floor are gated at the floor; the report keeps their measured value.
 */
export const MINIMUM_OPERATION_BUDGET_MS = 5;
const roundedUp = (value: number): number => Math.ceil(value * 100) / 100;

const measuredP95 = (
  operations: ReadonlyArray<BenchOperationMeasurement>,
  sampleCount: number
): ReadonlyArray<{ key: string; p95Ms: number }> => {
  const tooWeak = operations.filter(
    (operation) =>
      operation.samplesMs.length !== sampleCount ||
      operation.p95Ms === null ||
      !Number.isFinite(operation.p95Ms) ||
      operation.errors > 0
  );
  if (tooWeak.length > 0) {
    throw new Error(
      `bench.budgets.weak_evidence: ${tooWeak
        .map((operation) => `${operation.key} needs exactly ${sampleCount} successful p95 samples`)
        .join('; ')}`
    );
  }
  return operations.map((operation) => ({ key: operation.key, p95Ms: operation.p95Ms! }));
};

/**
 * Turns one measured pass into checked-in budgets.
 *
 * A budget is an observed p95 multiplied by explicit headroom, never a formula over
 * schema shape: row counts and graph depth do not predict flush or propagation cost.
 */
export type CalibrationRun = Pick<
  BenchRunReport,
  'caseId' | 'dimensions' | 'backend' | 'operations' | 'verdict' | 'oracle'
> &
  BudgetMeasurement;

export function assertBudgetMeasurement(budgets: BenchBudgets, current: BudgetMeasurement): void {
  const recorded = budgets.provenance;
  for (const field of ['version', 'warmupStrategy', 'timingScope', 'statistic'] as const) {
    if (recorded.measurementProtocol[field] !== current.measurementProtocol[field]) {
      throw new Error(
        `bench.budgets.measurement_protocol_changed: measurementProtocol.${field}; recalibration required`
      );
    }
  }
  for (const field of ['warmup', 'repetitions', 'samples'] as const) {
    if (recorded[field] !== current[field]) {
      throw new Error(
        `bench.budgets.measurement_protocol_changed: ${field}; recalibration required`
      );
    }
  }
}

export function budgetsFromRuns(input: {
  readonly runs: ReadonlyArray<CalibrationRun>;
  readonly headroom: number;
  readonly source: string;
  readonly calibratedAt?: string;
}): BenchBudgets {
  if (!(input.headroom >= 1)) throw new Error('bench.budgets.headroom_invalid');
  const first = input.runs[0];
  const samples = first?.samples ?? 0;
  if (samples * (first?.repetitions ?? 1) < minimumSamplesForPercentileResolution(0.95) || !first) {
    throw new Error(
      'bench.budgets.weak_evidence: a nonempty suite with at least 20 samples is required'
    );
  }
  const cases: Record<string, z.infer<typeof CaseBudgetSchema>> = {};
  for (const run of input.runs) {
    MeasurementProtocolSchema.parse(run.measurementProtocol);
    if (
      run.backend !== first.backend ||
      run.samples !== first.samples ||
      run.warmup !== first.warmup ||
      run.repetitions !== first.repetitions ||
      (['version', 'warmupStrategy', 'timingScope', 'statistic'] as const).some(
        (field) => run.measurementProtocol[field] !== first.measurementProtocol[field]
      )
    ) {
      throw new Error('bench.budgets.measurement_protocol_changed: calibration runs differ');
    }
    if (run.verdict !== 'pass' || run.oracle.status !== 'pass' || run.operations.length === 0) {
      throw new Error(`bench.budgets.correctness_failed: ${run.caseId}`);
    }
    const scenarioId = String(run.dimensions?.scenarioId ?? run.caseId);
    const operations = measuredP95(run.operations, samples * run.repetitions);
    const budgetsWithFloor = operations.map((operation) => ({
      key: operation.key,
      maxP95Ms: roundedUp(Math.max(operation.p95Ms * input.headroom, MINIMUM_OPERATION_BUDGET_MS)),
    }));
    cases[scenarioId] = {
      caseId: run.caseId,
      ruleId: String(run.dimensions?.ruleId ?? 'unknown'),
      maxP95Ms: roundedUp(budgetsWithFloor.reduce((sum, operation) => sum + operation.maxP95Ms, 0)),
      operations: Object.fromEntries(
        budgetsWithFloor.map((operation) => [operation.key, { maxP95Ms: operation.maxP95Ms }])
      ),
    };
  }
  return BenchBudgetsSchema.parse({
    schema: BUDGETS_SCHEMA_VERSION,
    headroom: input.headroom,
    floorMs: MINIMUM_OPERATION_BUDGET_MS,
    provenance: {
      source: input.source,
      backend: first.backend,
      measurementProtocol: first.measurementProtocol,
      warmup: first.warmup,
      repetitions: first.repetitions,
      samples,
      calibratedAt: input.calibratedAt ?? new Date().toISOString(),
    },
    cases,
  });
}

export function policyForCase(
  budgets: BenchBudgets,
  scenarioId: string
): BenchManifestPerformancePolicy | undefined {
  const entry = budgets.cases[scenarioId];
  if (!entry) return undefined;
  return {
    modelVersion: 'tea-bench-budget/1',
    source: `${budgets.provenance.source} (${budgets.provenance.backend}, ${budgets.provenance.samples} samples × ${budgets.provenance.repetitions} repetitions, ${budgets.provenance.warmup} warmup passes, ${budgets.headroom}× headroom, calibrated ${budgets.provenance.calibratedAt})`,
    maxP95Ms: entry.maxP95Ms,
    operations: entry.operations,
  };
}
