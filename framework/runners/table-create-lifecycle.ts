import { PerfRunDiagnosticError } from "../types";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";

// The lifecycle skeleton shared by the table-create family: no seed, no reusable
// fixture — the measured operation CREATES entities from scratch inside one timed
// window and drops them on cleanup. It mirrors field-add-lifecycle's
// success/diagnostic/cleanup protocol but deliberately OMITS the
// seedReady/seedMode machinery, because a table-create case has nothing to seed:
// `prepareFixture` only allocates a mutable run accumulator (the created-entity
// list + its measurements) so the driver's buildResult and cleanup can read
// partial state even when the measured loop throws mid-way.
//
// Because there is no seed cache, this family never emits a seedHash — so the
// seedHash diff-mask dance the field-add family needs (mask the content-address
// so a behavior-preserving migration still passes the G1 diff) does NOT apply
// here. The migration is purely a re-shape of orchestration around the unchanged
// result-assembly logic.
//
// The driver owns the repeated protocol:
//   prepareFixture(allocate) -> runPrimary(measured create + verify, mutating the
//   fixture) -> build result (twice: diagnostic catch + success) -> finally
//   drop-what-was-created cleanup.
//
// Scope note: table-create-family-shaped, not a universal driver. It assumes a
// seedless, create-from-scratch workload whose cleanup drops exactly what it
// created, and whose partial progress lives on a mutable fixture. A broader
// abstraction should wait for a second seedless family.

export type TableCreateLifecyclePrepareArgs<TConfig> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: TConfig;
};

export type TableCreateLifecycleBuildResultArgs<TConfig, TFixture, TPrimary> = {
  config: TConfig;
  fixture?: TFixture;
  primary?: TPrimary;
  error?: unknown;
};

export type TableCreateLifecycleSpec<TConfig, TFixture, TPrimary> = {
  // Allocate the mutable run accumulator the measured operation fills in.
  // table-create has no seed, so this does no I/O and must not throw; the
  // returned fixture is the partial-state carrier buildResult and cleanup read
  // when the measured operation fails part-way.
  prepareFixture: (
    args: TableCreateLifecyclePrepareArgs<TConfig>,
  ) => Promise<TFixture>;
  // The measured operation: create the entities (trace-wrapped, with per-entity
  // routing assertions) and verify them, mutating the fixture in place so
  // partial progress survives a throw. Owns its own measurements/phases; the
  // driver does not wrap it in a phase.
  runPrimary: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    baseId: string;
    fixture: TFixture;
    config: TConfig;
  }) => Promise<TPrimary>;
  // Assemble the artifact result from the (mutated) fixture. Called once on
  // success and once inside the diagnostic-error path (with `error` set), so it
  // must tolerate the partially-filled fixture left behind by a mid-run throw.
  buildResult: (
    args: TableCreateLifecycleBuildResultArgs<TConfig, TFixture, TPrimary>,
  ) => PerfRunResult;
  // Drop whatever the measured operation created. Runs in `finally`, so it must
  // tolerate an undefined fixture (prepare failed) and a partially-filled one.
  // `primaryAttempted` is true once the measured operation began.
  cleanup: (args: {
    baseId: string;
    fixture: TFixture | undefined;
    config: TConfig;
    primaryAttempted: boolean;
  }) => Promise<void>;
};

export const runTableCreateLifecycle = async <TConfig, TFixture, TPrimary>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: TableCreateLifecycleSpec<TConfig, TFixture, TPrimary>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixture: TFixture | undefined;
  let primaryAttempted = false;

  try {
    fixture = await spec.prepareFixture({ perfCase, context, baseId, config });
    let primary: TPrimary | undefined;

    try {
      primaryAttempted = true;
      primary = await spec.runPrimary({
        perfCase,
        context,
        baseId,
        fixture,
        config,
      });
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({ config, fixture, primary, error }),
      );
    }

    return spec.buildResult({ config, fixture, primary });
  } finally {
    await spec.cleanup({ baseId, fixture, config, primaryAttempted });
  }
};
