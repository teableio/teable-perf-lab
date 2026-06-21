import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type {
  DuplicateRecordSeedBaseCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunnerKind,
  PerfRunResult,
} from "../types";
import {
  assertDuplicateSourceReady,
  assertRecordCount,
  deleteRecordsInBatches,
  prepareDuplicateSourceFixture,
  type DuplicateRecordFixture,
  type SourceReadyVerification,
} from "./record-duplicate.shared";

// The lifecycle skeleton shared by selection-duplicate / record-duplicate-single.
// Before this driver, both runners hand-wrote the identical control flow:
// prepare(seed) -> seedReady -> the one measured duplicate operation -> verify ->
// build result (twice: catch + success) -> finally restore-back cleanup (delete
// the rows the duplicate created so the cached seed is left at its original row
// count, else drop the table). Only what actually varies between the two is
// declared by `RecordDuplicateSpec`; everything else lives here, once.
//
// Scope note: this driver is intentionally record-duplicate-family-shaped (both
// runners back onto record-duplicate.shared.ts and the `duplicateRecord`
// feature), not a universal runner driver.

export type RecordDuplicateRunner = Extract<
  PerfRunnerKind,
  "selection-duplicate" | "record-duplicate-single"
>;

export type RecordDuplicateHookArgs<
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
> = {
  fixture: DuplicateRecordFixture;
  config: TConfig;
  perfCase: PerfCase;
  context: PerfRunContext;
};

export type RecordDuplicateBuildArgs<
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
  TPrimary,
  TVerification,
> = {
  config: TConfig;
  fixture?: DuplicateRecordFixture;
  prepareMeasurement?: Measurement<DuplicateRecordFixture>;
  sourceReadyMeasurement?: Measurement<SourceReadyVerification>;
  primaryMeasurement?: Measurement<TPrimary>;
  verifyMeasurement?: Measurement<TVerification>;
  error?: unknown;
};

export type RecordDuplicateSpec<
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
  TPrimary,
  TVerification,
> = {
  runner: RecordDuplicateRunner;
  // Hash-input version + cache identity for the source fixture; must stay
  // identical between seed mode and execute mode so the seed hash matches.
  fixtureVersion: string;
  // Human label used only in the restore-back warn message (not an artifact
  // field), e.g. "single duplicate" / "selection duplicate".
  seedLabel: string;
  // The single MEASURED duplicate operation. The runner owns the measure +
  // trace strategy (top-level stream trace vs per-iteration traces) and returns
  // the measurement whose name becomes the primary phase name.
  runPrimary: (
    args: RecordDuplicateHookArgs<TConfig>,
  ) => Promise<Measurement<TPrimary>>;
  // Verify the duplicated records and final row count through the real read path.
  verify: (
    args: RecordDuplicateHookArgs<TConfig> & { primaryResult: TPrimary },
  ) => Promise<TVerification>;
  // The record ids the measured operation created; deleted in restore-back
  // cleanup so a reusable seed returns to its original row count.
  getCreatedRecordIds: (primaryResult: TPrimary | undefined) => string[];
  buildResult: (
    args: RecordDuplicateBuildArgs<TConfig, TPrimary, TVerification>,
  ) => PerfRunResult;
};

const restoreOrDropFixture = async <
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
>(
  baseId: string,
  fixture: DuplicateRecordFixture | undefined,
  config: TConfig,
  createdRecordIds: string[],
  seedLabel: string,
) => {
  if (!fixture || isExecuteDbIsolated()) {
    // CI execute jobs run on an isolated restored copy of the seed dump, so the
    // mutated database is simply discarded after the job.
    return;
  }

  const dropTable = async () => {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  };

  if (!fixture.reusableSeed) {
    await dropTable();
    return;
  }

  // The duplicate appended rows to a reusable seed. Delete just those rows so
  // the cached fixture stays at its seeded row count; if that fails, drop it so
  // the next run reseeds cleanly.
  try {
    if (createdRecordIds.length > 0) {
      await deleteRecordsInBatches(fixture.tableId, createdRecordIds);
    }
    await assertRecordCount(
      fixture,
      config.rowCount,
      config.verify.fullScanPageSize ?? 1_000,
    );
  } catch (error) {
    console.warn(
      `Failed to restore cached ${seedLabel} seed ${fixture.tableId}; deleting it`,
      error,
    );
    await dropTable();
  }
};

export const runRecordDuplicateLifecycle = async <
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
  TPrimary,
  TVerification,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordDuplicateSpec<TConfig, TPrimary, TVerification>,
): Promise<PerfRunResult> => {
  // The registry dispatch guarantees this runner kind's case config matches the
  // spec's TConfig; the generic widens the union so cast through unknown.
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<DuplicateRecordFixture> | undefined;
  let sourceReadyMeasurement: Measurement<SourceReadyVerification> | undefined;
  let primaryMeasurement: Measurement<TPrimary> | undefined;
  let verifyMeasurement: Measurement<TVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareDuplicateSourceFixture({
        baseId,
        tableName,
        config,
        perfCase,
        runner: spec.runner,
        fixtureVersion: spec.fixtureVersion,
      }),
    );
    const fixture = prepareMeasurement.result;
    sourceReadyMeasurement = await measureAsync("seedReady", () =>
      assertDuplicateSourceReady(fixture, config),
    );

    const hookArgs: RecordDuplicateHookArgs<TConfig> = {
      fixture,
      config,
      perfCase,
      context,
    };

    try {
      primaryMeasurement = await spec.runPrimary(hookArgs);
      verifyMeasurement = await measureAsync("verify", () =>
        spec.verify({ ...hookArgs, primaryResult: primaryMeasurement!.result }),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          fixture,
          prepareMeasurement,
          sourceReadyMeasurement,
          primaryMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      fixture,
      prepareMeasurement,
      sourceReadyMeasurement,
      primaryMeasurement,
      verifyMeasurement,
    });
  } finally {
    await restoreOrDropFixture(
      baseId,
      prepareMeasurement?.result,
      config,
      spec.getCreatedRecordIds(primaryMeasurement?.result),
      spec.seedLabel,
    );
  }
};

export const seedRecordDuplicateLifecycle = async <
  TConfig extends DuplicateRecordSeedBaseCaseConfig,
  TPrimary,
  TVerification,
>(
  perfCase: PerfCase,
  _context: PerfRunContext,
  spec: RecordDuplicateSpec<TConfig, TPrimary, TVerification>,
): Promise<PerfRunResult> => {
  // The registry dispatch guarantees this runner kind's case config matches the
  // spec's TConfig; the generic widens the union so cast through unknown.
  const config = perfCase.config as unknown as TConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareDuplicateSourceFixture({
      baseId,
      tableName,
      config,
      perfCase,
      runner: spec.runner,
      fixtureVersion: spec.fixtureVersion,
    }),
  );
  const sourceReadyMeasurement = await measureAsync("seedReady", () =>
    assertDuplicateSourceReady(prepareMeasurement.result, config),
  );

  return spec.buildResult({
    config,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    sourceReadyMeasurement,
  });
};
