import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";

// The lifecycle skeleton shared by the field-convert family: seed a populated
// table, assert the seed sample state, run one measured `convertField` request
// and wait for the converted column to become readable, then clean up. Two
// runner kinds ride it from the start — field-convert (scalar/computed column
// conversions) and field-convert-link (link <-> text conversions, which also
// seed a foreign table) — so the shared shape is a real seam, not a guess.
//
// The driver owns the repeated protocol:
//   prepare(seed) -> seedReady -> measured convert+readiness -> build result
//   (twice: diagnostic catch + success) -> finally keep-or-delete cleanup.
// The conversion rewrites the source column in place (Class D), so a cached
// seed cannot be cheaply restored: the driver keeps the fixture only when the
// execute DB is isolated (CI discards it) or a reusable seed was never
// converted, and otherwise asks the runner to drop the fixture table(s). Each
// runner declares the case semantics it varies: the seed fixture, the seed
// assertion, the measured convert + readiness bundle, the result assembly, and
// which table(s) to delete on cleanup.
//
// Scope note: field-convert-family-shaped, not a universal driver. It assumes
// the prepare step carries its own create/seed measurements on the fixture
// (no separate "prepare" phase) and a single measured convert operation.

export type FieldConvertLifecycleConfig = {
  tableNamePrefix: string;
  threshold: { metric: string };
};

export type FieldConvertLifecycleFixture = {
  tableId: string;
  reusableSeed: boolean;
};

export type FieldConvertLifecycleBuildResultArgs<
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = {
  config: TConfig;
  fixture?: TFixture;
  seedReadyMeasurement?: Measurement<TSeedReady>;
  primaryMeasurement?: Measurement<TPrimary>;
  error?: unknown;
};

export type FieldConvertLifecycleSpec<
  TConfig extends FieldConvertLifecycleConfig,
  TFixture extends FieldConvertLifecycleFixture,
  TSeedReady,
  TPrimary,
> = {
  // Build (or restore from the seed cache) the populated table the conversion
  // runs against. The migrated runner owns its own cache shape and carries its
  // create/seed measurements on the returned fixture.
  prepareFixture: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    baseId: string;
    tableName: string;
    config: TConfig;
  }) => Promise<TFixture>;
  // Assert the seeded source column is in its expected pre-convert state.
  assertSeedReady: (args: {
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation: the convertField request (trace-wrapped), routing
  // assertion, and the converted-column readiness waits, bundled into the
  // primary result whose measured duration is the primary metric.
  runPrimary: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TPrimary>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path (with `error` set).
  buildResult: (
    args: FieldConvertLifecycleBuildResultArgs<
      TConfig,
      TFixture,
      TSeedReady,
      TPrimary
    >,
  ) => PerfRunResult;
  // Delete the fixture table(s). Runs only when the fixture is not kept (see
  // keepFixture below); field-convert drops the host table, field-convert-link
  // also drops its foreign table.
  cleanupConvertedFixture: (args: {
    baseId: string;
    fixture: TFixture;
  }) => Promise<void>;
};

export const seedFieldConvertLifecycle = async <
  TConfig extends FieldConvertLifecycleConfig,
  TFixture extends FieldConvertLifecycleFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldConvertLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const fixture = await spec.prepareFixture({
    perfCase,
    context,
    baseId,
    tableName,
    config,
  });
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    spec.assertSeedReady({ fixture, config }),
  );

  return spec.buildResult({ config, fixture, seedReadyMeasurement });
};

export const runFieldConvertLifecycle = async <
  TConfig extends FieldConvertLifecycleConfig,
  TFixture extends FieldConvertLifecycleFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldConvertLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let fixture: TFixture | undefined;
  let convertAttempted = false;

  try {
    fixture = await spec.prepareFixture({
      perfCase,
      context,
      baseId,
      tableName,
      config,
    });
    let seedReadyMeasurement: Measurement<TSeedReady> | undefined;
    let primaryMeasurement: Measurement<TPrimary> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        spec.assertSeedReady({ fixture: fixture as TFixture, config }),
      );
      convertAttempted = true;
      primaryMeasurement = await measureAsync(config.threshold.metric, () =>
        spec.runPrimary({
          perfCase,
          context,
          fixture: fixture as TFixture,
          config,
        }),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          fixture,
          seedReadyMeasurement,
          primaryMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      fixture,
      seedReadyMeasurement,
      primaryMeasurement,
    });
  } finally {
    // Class D cleanup: the conversion rewrites the source column in place, so a
    // cached seed cannot be cheaply restored. Keep the fixture only when the
    // execute DB is isolated (CI discards the restored copy) or a reusable seed
    // was never converted; otherwise drop the fixture table(s).
    const keepFixture =
      isExecuteDbIsolated() || (fixture?.reusableSeed && !convertAttempted);
    if (fixture && !keepFixture) {
      await spec.cleanupConvertedFixture({ baseId, fixture });
    }
  }
};
