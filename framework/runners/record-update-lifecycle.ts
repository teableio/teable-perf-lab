import { measureAsync } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import {
  buildRecordWindowId,
  withRecordWindowId,
  type Measurement,
} from "./record-undo-redo.shared";

// The lifecycle skeleton shared by the record-update mutation family: seed a
// record table, run one measured bulk mutation inside a window, verify the
// final state, then restore-or-delete the reusable fixture. Before this driver
// the runner hand-wrote the identical control flow:
// prepare(seed) -> seedReady -> withRecordWindowId(measured op) -> build result
// (twice: diagnostic catch + success) -> finally cleanup. Only the
// case-specific pieces vary, declared by `RecordUpdateLifecycleSpec`; the
// protocol lives here once.
//
// Scope note: this driver is intentionally record-update-family-shaped, not a
// universal runner driver. It owns generic protocol only; the measured-window
// body (operation + routing + verification bundling), the seed-cache fixture,
// the result assembly, and the restore-or-delete cleanup stay in the runner as
// case semantics. A truly generic record-mutation driver should emerge only
// after a second mutation family migrates and proves the shared shape (two
// examples = a real seam, one = a guess).

export type RecordUpdateLifecycleConfig = { tableNamePrefix: string };

export type RecordUpdateLifecycleRunArgs<TConfig, TFixture> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: TConfig;
  fixture: TFixture;
  windowId: string;
};

export type RecordUpdateLifecycleBuildResultArgs<
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = {
  config: TConfig;
  fixture?: TFixture;
  windowId?: string;
  prepareMeasurement?: Measurement<TFixture>;
  seedReadyMeasurement?: Measurement<TSeedReady>;
  primaryMeasurement?: Measurement<TPrimary>;
  error?: unknown;
};

export type RecordUpdateLifecycleSpec<
  TConfig extends RecordUpdateLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = {
  // Build (or restore from the seed cache) the table + records the measured
  // mutation runs against. The migrated runner owns its own cache shape.
  prepareFixture: (args: {
    baseId: string;
    tableName: string;
    config: TConfig;
    perfCase: PerfCase;
    context: PerfRunContext;
  }) => Promise<TFixture>;
  // Assert the seeded state is readable before the measured operation runs.
  assertSeedReady: (args: {
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation, run INSIDE the window. It owns its own trace step,
  // measurement, routing assertion, and post-operation verification, returning
  // the bundled primary measurement whose duration is the primary metric.
  runMeasuredOperation: (
    args: RecordUpdateLifecycleRunArgs<TConfig, TFixture>,
  ) => Promise<Measurement<TPrimary>>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path; both pass the same measurement bag (with `error` set
  // on the failure path).
  buildResult: (
    args: RecordUpdateLifecycleBuildResultArgs<
      TConfig,
      TFixture,
      TSeedReady,
      TPrimary
    >,
  ) => PerfRunResult;
  // Restore the reusable seed or drop the table; runs in `finally`, so it must
  // tolerate an undefined fixture (prepare failed).
  cleanup: (args: {
    baseId: string;
    fixture: TFixture | undefined;
    config: TConfig;
    windowId: string;
  }) => Promise<void>;
};

export const seedRecordUpdateLifecycle = async <
  TConfig extends RecordUpdateLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordUpdateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    spec.prepareFixture({ baseId, tableName, config, perfCase, context }),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    spec.assertSeedReady({ fixture: prepareMeasurement.result, config }),
  );

  return spec.buildResult({
    config,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

export const runRecordUpdateLifecycle = async <
  TConfig extends RecordUpdateLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordUpdateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<TFixture> | undefined;
  let seedReadyMeasurement: Measurement<TSeedReady> | undefined;
  let fixture: TFixture | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      spec.prepareFixture({ baseId, tableName, config, perfCase, context }),
    );
    fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      spec.assertSeedReady({ fixture: fixture as TFixture, config }),
    );
    let primaryMeasurement: Measurement<TPrimary> | undefined;

    try {
      await withRecordWindowId(windowId, async () => {
        primaryMeasurement = await spec.runMeasuredOperation({
          perfCase,
          context,
          config,
          fixture: fixture as TFixture,
          windowId,
        });
      });
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          fixture,
          windowId,
          prepareMeasurement,
          seedReadyMeasurement,
          primaryMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      fixture,
      windowId,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
    });
  } finally {
    await spec.cleanup({ baseId, fixture, config, windowId });
  }
};
