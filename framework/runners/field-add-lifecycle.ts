import { measureAsync } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import type { Measurement } from "./record-undo-redo.shared";

// The lifecycle skeleton shared by the field-add family: seed a populated
// (possibly multi-) table, assert the seed sample state, run one measured
// field-add operation and wait for the new column to backfill, then restore the
// seed by deleting the added field — or drop the fixture table(s). conditional-
// lookup is the first runner kind on it (add a conditional lookup field over a
// seeded source + host pair); field-duplicate and field-create join next, so the
// shared shape is born from one member and proven generic as the family migrates.
//
// The driver owns the repeated protocol:
//   prepare(seed) -> seedReady -> measured field-add + readiness -> build result
//   (twice: diagnostic catch + success) -> finally restore-or-delete cleanup.
//
// Two deliberate differences from the sibling drivers keep this family honest:
//   * Unlike record-mutation-lifecycle, the driver emits NO "prepare" phase. The
//     prepare step carries its own create/seed sub-measurements on the fixture,
//     and those phase names vary with seed-cache state (seedBuild / createTables
//     on a miss, seedRestore on a hit), so the runner owns them.
//   * Unlike field-convert-lifecycle, the driver does NOT wrap the primary in a
//     single measureAsync(threshold.metric). A field-add runner's primary is
//     multi-phase (create the field, then a backfill-readiness scan) feeding a
//     computed threshold metric, so runPrimary owns its own trace step(s) and
//     measurement(s) and returns the bundle buildResult unpacks.
//
// Cleanup is Class C restore-or-delete: the measured operation only ADDS a field,
// so a reusable seed is restored by deleting that added field while a fresh
// (non-reusable) fixture is dropped. The driver delegates the whole decision to
// the runner's cleanup (which holds the seed-cache + execute-isolation context),
// passing whether the primary was attempted.
//
// Scope note: field-add-family-shaped, not a universal driver. It assumes the
// prepare step carries its own seed measurements (no "prepare" phase), a single
// measured field-add operation against a reusable fixture, and restore-by-delete
// cleanup. A broader abstraction should wait for a family that breaks one of
// those assumptions.

export type FieldAddLifecyclePrepareArgs<TConfig> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: TConfig;
  // True on the seed (prepare-DB) path, false on the measured execute path. Lets
  // a runner pick its seed-vs-run table-name suffix; the fixture is otherwise
  // opaque to the driver, so it may span more than one table.
  seedMode: boolean;
};

export type FieldAddLifecycleBuildResultArgs<
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = {
  config: TConfig;
  fixture?: TFixture;
  seedReadyMeasurement?: Measurement<TSeedReady>;
  primary?: TPrimary;
  error?: unknown;
};

export type FieldAddLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary> = {
  // Build (or restore from the seed cache) the table(s) the field-add runs
  // against. Carries its own create/seed measurements on the returned fixture, so
  // the driver emits no "prepare" phase.
  prepareFixture: (
    args: FieldAddLifecyclePrepareArgs<TConfig>,
  ) => Promise<TFixture>;
  // Assert the seeded state is in its expected pre-add shape, emitted as the
  // `seedReady` phase by the driver.
  assertSeedReady: (args: {
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation: the field-add request(s) (trace-wrapped), routing
  // assertion if any, and the backfill-readiness wait(s), each owning its own
  // measurement and bundled into the returned primary. The driver does not wrap
  // this in a phase — the runner's measurements become the phases and the
  // (possibly computed) primary metric in buildResult.
  runPrimary: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TPrimary>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path (with `error` set and `primary` absent).
  buildResult: (
    args: FieldAddLifecycleBuildResultArgs<
      TConfig,
      TFixture,
      TSeedReady,
      TPrimary
    >,
  ) => PerfRunResult;
  // Restore the reusable seed by deleting the added field(s), or drop the fixture
  // table(s). Runs in `finally`, so it must tolerate an undefined fixture (prepare
  // failed). `primaryAttempted` is true once the measured operation began.
  cleanup: (args: {
    baseId: string;
    fixture: TFixture | undefined;
    config: TConfig;
    primaryAttempted: boolean;
  }) => Promise<void>;
};

export const seedFieldAddLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldAddLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const fixture = await spec.prepareFixture({
    perfCase,
    context,
    baseId,
    config,
    seedMode: true,
  });
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    spec.assertSeedReady({ baseId, fixture, config }),
  );

  return spec.buildResult({ config, fixture, seedReadyMeasurement });
};

export const runFieldAddLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldAddLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixture: TFixture | undefined;
  let primaryAttempted = false;

  try {
    fixture = await spec.prepareFixture({
      perfCase,
      context,
      baseId,
      config,
      seedMode: false,
    });
    let seedReadyMeasurement: Measurement<TSeedReady> | undefined;
    let primary: TPrimary | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        spec.assertSeedReady({ baseId, fixture: fixture as TFixture, config }),
      );
      primaryAttempted = true;
      primary = await spec.runPrimary({
        perfCase,
        context,
        baseId,
        fixture: fixture as TFixture,
        config,
      });
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          fixture,
          seedReadyMeasurement,
          primary,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      fixture,
      seedReadyMeasurement,
      primary,
    });
  } finally {
    await spec.cleanup({ baseId, fixture, config, primaryAttempted });
  }
};
