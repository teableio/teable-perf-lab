import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import {
  buildRecordWindowId,
  withRecordWindowId,
} from "./record-undo-redo.shared";

// The lifecycle skeleton shared by the record-mutation family: seed a record
// table, run one measured bulk mutation, verify the final state, then
// restore-or-delete the reusable fixture. Five runner kinds now ride it —
// record-update (bulk update over seeded rows, runs inside a record window),
// record-create (bulk insert into an empty seeded table, no window),
// record-reorder (block reorder over seeded rows, record window),
// selection-clear (clear-stream over seeded rows, no window, no seedReady
// phase), and record-update-link (bulk link-cell update over a host + linked
// foreign fixture, no window) — so the shared shape is a proven seam, not a
// guess. The driver owns generic protocol only:
//   prepare(seed) -> [seedReady?] -> [window?] measured op -> build result
//   (twice: diagnostic catch + success) -> finally cleanup.
// Each runner declares the case semantics it varies: the seed-cache fixture,
// the (optional) seed-ready assertion, the bundled measured window (operation +
// routing + verification), the result assembly, and the restore-or-delete
// cleanup. assertSeedReady is optional: selection-clear confirms seed readiness
// inside prepareFixture and emits only a post-op verify phase, so it omits the
// hook and the driver produces no seedReady phase.
//
// Scope note: this is record-mutation-family-shaped, not a universal runner
// driver. The fixture is opaque to the driver, so it may span more than one
// table — record-update-link seeds a host + linked foreign pair and rides this
// unchanged. It still assumes one primary measured operation against a reusable
// fixture cleaned up by restore-or-delete. A broader abstraction should wait
// for a family that breaks one of those remaining assumptions.

export type RecordMutationLifecycleConfig = { tableNamePrefix: string };

export type RecordMutationLifecycleRunArgs<TConfig, TFixture> = {
  baseId: string;
  perfCase: PerfCase;
  context: PerfRunContext;
  config: TConfig;
  fixture: TFixture;
  windowId: string;
};

export type RecordMutationLifecycleBuildResultArgs<
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

export type RecordMutationLifecycleSpec<
  TConfig extends RecordMutationLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = {
  // When true the measured operation runs inside withRecordWindowId so the
  // mutation is grouped under one record window id (record-update). Omit for
  // runners that have no window (record-create).
  useRecordWindow?: boolean;
  // Build (or restore from the seed cache) the table + records the measured
  // mutation runs against. The migrated runner owns its own cache shape.
  prepareFixture: (args: {
    baseId: string;
    tableName: string;
    config: TConfig;
    perfCase: PerfCase;
    context: PerfRunContext;
  }) => Promise<TFixture>;
  // Assert the seeded state is readable before the measured operation runs,
  // emitted as the `seedReady` phase. Optional: a family member whose seed
  // readiness is confirmed inside prepareFixture (and whose only post-op check
  // is a separate verify phase) omits it, so no `seedReady` phase is produced —
  // selection-clear rides the driver this way.
  assertSeedReady?: (args: {
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation. It owns its own trace step, measurement, routing
  // assertion, and post-operation verification, returning the bundled primary
  // measurement whose duration is the primary metric.
  runMeasuredOperation: (
    args: RecordMutationLifecycleRunArgs<TConfig, TFixture>,
  ) => Promise<Measurement<TPrimary>>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path (with `error` set).
  buildResult: (
    args: RecordMutationLifecycleBuildResultArgs<
      TConfig,
      TFixture,
      TSeedReady,
      TPrimary
    >,
  ) => PerfRunResult;
  // Restore the reusable seed or drop the table; runs in `finally`, so it must
  // tolerate an undefined fixture (prepare failed). `primaryMeasurement` is
  // available so a runner can undo exactly what the operation produced (e.g.
  // delete the records record-create inserted).
  cleanup: (args: {
    baseId: string;
    fixture: TFixture | undefined;
    config: TConfig;
    windowId: string;
    primaryMeasurement?: Measurement<TPrimary>;
  }) => Promise<void>;
};

export const seedRecordMutationLifecycle = async <
  TConfig extends RecordMutationLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordMutationLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    spec.prepareFixture({ baseId, tableName, config, perfCase, context }),
  );
  const assertSeedReady = spec.assertSeedReady;
  const seedReadyMeasurement = assertSeedReady
    ? await measureAsync("seedReady", () =>
        assertSeedReady({
          baseId,
          fixture: prepareMeasurement.result,
          config,
        }),
      )
    : undefined;

  return spec.buildResult({
    config,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

export const runRecordMutationLifecycle = async <
  TConfig extends RecordMutationLifecycleConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordMutationLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<TFixture> | undefined;
  let seedReadyMeasurement: Measurement<TSeedReady> | undefined;
  let primaryMeasurement: Measurement<TPrimary> | undefined;
  let fixture: TFixture | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      spec.prepareFixture({ baseId, tableName, config, perfCase, context }),
    );
    fixture = prepareMeasurement.result;
    const assertSeedReady = spec.assertSeedReady;
    if (assertSeedReady) {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertSeedReady({ baseId, fixture: fixture as TFixture, config }),
      );
    }

    try {
      const invokeMeasured = async () => {
        primaryMeasurement = await spec.runMeasuredOperation({
          baseId,
          perfCase,
          context,
          config,
          fixture: fixture as TFixture,
          windowId,
        });
      };
      if (spec.useRecordWindow) {
        await withRecordWindowId(windowId, invokeMeasured);
      } else {
        await invokeMeasured();
      }
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
    await spec.cleanup({
      baseId,
      fixture,
      config,
      windowId,
      primaryMeasurement,
    });
  }
};
