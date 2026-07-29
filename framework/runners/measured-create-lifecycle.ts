// The lifecycle skeleton shared by the field-add and duplicate families.
//
// Both families independently grew the same driver, and the two files were
// line-for-line identical once the family noun was normalised (135 of 135
// non-comment lines). Each file's scope note said a broader abstraction should
// wait until a family actually grew; both have since grown — field-add carries
// nine runner kinds, duplicate four — so the shape is proven, and this module
// now owns it. `field-add-lifecycle.ts` and `duplicate-lifecycle.ts` remain as
// the family-named surfaces their runners import.
//
// The protocol:
//   prepare(seed) -> [seedReady] -> measured primary + verify -> build result
//   (twice: diagnostic catch + success) -> finally cleanup.
//
// Two deliberate choices, inherited unchanged from both originals:
//   * The driver emits NO "prepare" phase. The prepare step carries its own
//     create/seed sub-measurement on the returned fixture, so the runner owns it
//     and surfaces it from buildResult.
//   * The driver does NOT wrap runPrimary in a single measureAsync(metric). A
//     primary is multi-phase (a trace-wrapped request, then a readiness scan)
//     feeding a computed threshold metric, so runPrimary owns its own trace
//     step(s) and measurement and returns the bundle buildResult unpacks.
//
// Cleanup is delegated entirely to the runner's cleanup, which holds the
// seed-cache and execute-isolation context; the driver only passes whether the
// primary was attempted.

import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";

export type MeasuredCreatePrepareArgs<TConfig> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: TConfig;
  // True on the seed (prepare-DB) path, false on the measured execute path. Lets
  // a runner pick its seed-vs-run table-name suffix; the fixture is otherwise
  // opaque to the driver, so it may span more than one table.
  seedMode: boolean;
};

export type MeasuredCreateBuildResultArgs<
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

export type MeasuredCreateSpec<TConfig, TFixture, TSeedReady, TPrimary> = {
  // Build (or restore from the seed cache) the table(s) the field-add runs
  // against. Carries its own create/seed measurements on the returned fixture, so
  // the driver emits no "prepare" phase.
  prepareFixture: (
    args: MeasuredCreatePrepareArgs<TConfig>,
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
    args: MeasuredCreateBuildResultArgs<
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

export const seedMeasuredCreateLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: MeasuredCreateSpec<TConfig, TFixture, TSeedReady, TPrimary>,
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

export const runMeasuredCreateLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: MeasuredCreateSpec<TConfig, TFixture, TSeedReady, TPrimary>,
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
