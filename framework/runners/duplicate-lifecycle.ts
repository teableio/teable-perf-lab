import { measureAsync } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import type { Measurement } from "./record-undo-redo.shared";

// The lifecycle skeleton shared by the duplicate family: seed (or restore) a
// populated source entity, assert it is in its expected pre-duplicate shape, run
// one measured duplicate request and verify the produced copy, then drop the
// copy (and the source unless it is a reusable cached seed). duplicate-table is
// the first runner kind on it (duplicate a seeded source table); duplicate-base
// is the deferred second member, so the shape is born from one member and proven
// generic only when the family actually grows.
//
// The driver owns the repeated protocol:
//   prepare(seed) -> seedReady -> measured duplicate + verify -> build result
//   (twice: diagnostic catch + success) -> finally drop-copy(+source) cleanup.
//
// Two deliberate choices keep this family honest, mirroring field-add-lifecycle:
//   * The driver emits NO "prepare" phase. The prepare step carries its own
//     create/seed sub-measurement on the returned fixture (named "prepare", or a
//     synthetic seedBuild/seedRestore marker on the seed path), so the runner
//     owns it and surfaces it from buildResult.
//   * The driver does NOT wrap runPrimary in a single measureAsync(metric). A
//     duplicate runner's primary is multi-phase (the trace-wrapped duplicate
//     request, then a copy-readiness full scan) feeding a computed threshold
//     metric, so runPrimary owns its own trace step(s) and measurement and
//     returns the bundle buildResult unpacks.
//
// Cleanup is Class C drop-or-keep: the measured operation CREATES a brand-new
// duplicate entity, so cleanup always drops that copy, and additionally drops
// the source unless it is a reusable cached seed (which the next run reuses).
// The driver delegates the whole decision to the runner's cleanup (which holds
// the seed-cache + execute-isolation context and the created-copy id parked on
// the fixture), passing whether the primary was attempted.
//
// Scope note: duplicate-family-shaped, not a universal driver. It assumes the
// prepare step carries its own seed measurement (no "prepare" phase), a single
// measured duplicate operation against a reusable source fixture, and
// drop-the-copy cleanup. A broader abstraction should wait for the second member
// (duplicate-base) to prove the common shape.

export type DuplicateLifecyclePrepareArgs<TConfig> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: TConfig;
  // True on the seed (prepare-DB) path, false on the measured execute path. Lets
  // a runner pick its seed-vs-run source-name suffix; the fixture is otherwise
  // opaque to the driver, so it may span more than one table/entity.
  seedMode: boolean;
};

export type DuplicateLifecycleBuildResultArgs<
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

export type DuplicateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary> = {
  // Build (or restore from the seed cache) the source entity the duplicate runs
  // against. Carries its own create/seed measurement on the returned fixture, so
  // the driver emits no "prepare" phase.
  prepareFixture: (
    args: DuplicateLifecyclePrepareArgs<TConfig>,
  ) => Promise<TFixture>;
  // Assert the seeded source is in its expected pre-duplicate shape, emitted as
  // the `seedReady` phase by the driver.
  assertSeedReady: (args: {
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation: the duplicate request (trace-wrapped), routing
  // assertion, and the copy-readiness verification, bundled into the returned
  // primary. The runner MUST park the created copy's id on the (mutable) fixture
  // so cleanup can drop it even when verification throws after the copy exists.
  // The driver does not wrap this in a phase — the runner's measurement becomes
  // the phases and the (computed) primary metric in buildResult.
  runPrimary: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TPrimary>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path (with `error` set and `primary` possibly absent).
  buildResult: (
    args: DuplicateLifecycleBuildResultArgs<
      TConfig,
      TFixture,
      TSeedReady,
      TPrimary
    >,
  ) => PerfRunResult;
  // Drop the created copy (parked on the fixture) and the source unless it is a
  // reusable cached seed. Runs in `finally`, so it must tolerate an undefined
  // fixture (prepare failed) and a copy that was never created.
  // `primaryAttempted` is true once the measured operation began.
  cleanup: (args: {
    baseId: string;
    fixture: TFixture | undefined;
    config: TConfig;
    primaryAttempted: boolean;
  }) => Promise<void>;
};

export const seedDuplicateLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: DuplicateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
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

export const runDuplicateLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: DuplicateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
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
