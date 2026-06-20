import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";

// The lifecycle skeleton shared by the read family: seed (or restore) a populated
// host table (plus any source tables it reads through), assert the seed is fully
// readable, run one measured READ workload over it, then drop the seed tables
// unless they are a reusable cached seed. record-read is the first runner kind on
// it (paged getRecords scan over a seeded host table); lookup-search-index is the
// second member (global search-index reads over the same kind of seed), so the
// shape is born from one member and proven generic only when the family grows.
//
// The driver owns the repeated protocol:
//   prepare(seed) -> seedReady -> measured read -> build result
//   (twice: diagnostic catch + success) -> finally drop-seed cleanup.
//
// Two deliberate choices keep this family honest, mirroring the duplicate family:
//   * The driver emits NO "prepare" phase. The prepare step carries its own
//     seed/restore sub-measurements on the returned fixture (record-read parks a
//     "prepare" measurement; lookup-search-index parks per-stage measurements and
//     emits no prepare phase at all), so the runner owns them and surfaces them
//     from buildResult.
//   * The driver does NOT wrap runPrimary in a single measureAsync(metric). A read
//     runner's primary is multi-phase (record-read: an optional baseline scan, the
//     trace-wrapped measured scan, and a verify pass; lookup-search-index: a
//     keyword x sample loop producing a p95), so runPrimary owns its own trace
//     step(s) and measurement(s) and returns the bundle buildResult unpacks.
//
// seedReady is computed OUTSIDE the diagnostic try (a seed-readiness failure throws
// raw, exactly as both members did before migrating); only the measured read is
// diagnostic-wrapped. So buildResult is always called with the fixture and the
// seedReady measurement defined — only `primary` is absent on the failure path.
//
// Cleanup is the read family's signature, and the driver OWNS it: a non-destructive
// read creates nothing to remove, so the driver drops only the seed tables the
// fixture owns, and only when they are NOT a reusable cached seed and the execute
// DB is not the throwaway isolated copy. The runner just declares which tables and
// whether the seed is reusable; it writes no cleanup boilerplate. (Contrast the
// duplicate family, whose measured op always creates a copy that cleanup must drop,
// so that driver delegates the whole cleanup decision back to the runner.)
//
// Scope note: read-family-shaped, not a universal driver. It assumes a
// non-destructive measured read against a reusable seed and drop-the-seed cleanup.
// A broader abstraction unifying this with the duplicate family should wait for a
// third family to prove the common shape.

export type ReadLifecyclePrepareArgs<TConfig> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: TConfig;
};

export type ReadLifecycleBuildResultArgs<
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

export type ReadLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary> = {
  // Build (or restore from the seed cache) the host/source tables the read runs
  // against. Carries its own seed/restore measurement(s) on the returned fixture,
  // so the driver emits no "prepare" phase.
  prepareFixture: (
    args: ReadLifecyclePrepareArgs<TConfig>,
  ) => Promise<TFixture>;
  // Assert the seeded tables are fully readable, emitted as the `seedReady` phase
  // by the driver.
  assertSeedReady: (args: {
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TSeedReady>;
  // The measured operation: the read(s) over the seed (trace-wrapped), routing
  // assertion, and verification, bundled into the returned primary. The driver
  // does not wrap this in a phase — the runner's measurement(s) become the phases
  // and the primary metric in buildResult.
  runPrimary: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TPrimary>;
  // Assemble the artifact result. Called once on success and once inside the
  // diagnostic-error path (with `error` set and `primary` absent). The driver
  // always supplies the fixture and seedReady measurement.
  buildResult: (
    args: ReadLifecycleBuildResultArgs<TConfig, TFixture, TSeedReady, TPrimary>,
  ) => PerfRunResult;
  // The seed tables this fixture owns, dropped on cleanup unless the seed is
  // reusable. Order is the runner's choice (e.g. host before source).
  seedTableIds: (fixture: TFixture) => string[];
  // Whether the seed is a reusable cached seed the next run reuses (so cleanup
  // keeps it). lookup-search-index's seed is always reusable; record-read's is
  // reusable only when the seed cache is enabled.
  isReusableSeed: (fixture: TFixture) => boolean;
};

const cleanupReadFixture = async <TConfig, TFixture, TSeedReady, TPrimary>(
  baseId: string,
  fixture: TFixture | undefined,
  spec: ReadLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<void> => {
  // CI execute jobs run on an isolated restored copy of the seed dump, so the
  // mutated database is simply discarded after the job.
  if (!fixture || isExecuteDbIsolated() || spec.isReusableSeed(fixture)) {
    return;
  }
  for (const tableId of spec.seedTableIds(fixture).filter(Boolean)) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${tableId}`, error);
    }
  }
};

export const runReadLifecycle = async <TConfig, TFixture, TSeedReady, TPrimary>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: ReadLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixture: TFixture | undefined;

  try {
    fixture = await spec.prepareFixture({ perfCase, context, baseId, config });
    const seedReadyMeasurement = await measureAsync("seedReady", () =>
      spec.assertSeedReady({ baseId, fixture: fixture as TFixture, config }),
    );
    let primary: TPrimary | undefined;

    try {
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
    await cleanupReadFixture(baseId, fixture, spec);
  }
};

export const seedReadLifecycle = async <
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: ReadLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const fixture = await spec.prepareFixture({
    perfCase,
    context,
    baseId,
    config,
  });
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    spec.assertSeedReady({ baseId, fixture, config }),
  );

  return spec.buildResult({ config, fixture, seedReadyMeasurement });
};
