import { measureAsync, type Measurement } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordUndoRedoBaseCaseConfig,
} from "../types";
import {
  assertRowsRestored,
  buildRecordReplayResult,
  buildRecordWindowId,
  cleanupRecordReplayFixture,
  prepareRecordReplayFixture,
  withRecordWindowId,
  type RecordReplaySetupMeasurements,
  type RecordReplayVerification,
  type RecordReplayFixture,
  type RecordReplayOperation,
} from "./record-replay.shared";

// The lifecycle skeleton shared by record-delete / record-undo / record-redo.
// Before this driver, all three runners hand-wrote the identical control flow:
// prepare(seed) -> seedReady -> optional setup phases -> the one measured
// operation (trace-wrapped) -> verify -> build result (twice: catch + success)
// -> finally cleanup. Only four things actually vary between them, declared by
// `RecordReplaySpec`. Everything else lives here, once.
//
// Scope note: this driver is intentionally record-replay-family-shaped, not a
// universal runner driver. The generic driver should emerge only after a second
// family migrates and shows the real shape (two examples = a real seam, one =
// a guess). See tasks/spec1-runner-driver-skeleton.md.

export type RecordReplayConfig = RecordUndoRedoBaseCaseConfig & {
  threshold: { metric: string; maxMs: number };
};

export type RecordReplayHookArgs = {
  fixture: RecordReplayFixture;
  context: PerfRunContext;
  perfCase: PerfCase;
  config: RecordReplayConfig;
  windowId: string;
};

export type RecordReplaySpec = {
  runner: Extract<
    PerfRunnerKind,
    "record-delete" | "record-undo" | "record-redo"
  >;
  operation: RecordReplayOperation;
  // Hash input for the seed cache; must be the migrated runner's own file so the
  // seed hash stays identical between seed mode (seedRecordReplayCase, which
  // hashes the same runner file) and execute mode.
  seedCodeFile: URL;
  // Ordered NON-measured setup steps run before the measured operation, inside
  // the same window id. Omit for runners with no setup (record-delete). The
  // returned bag flows straight into buildRecordReplayResult unchanged.
  runSetup?: (
    args: RecordReplayHookArgs,
  ) => Promise<RecordReplaySetupMeasurements>;
  // The single MEASURED operation; its duration becomes the primary metric.
  measuredOperation: (args: RecordReplayHookArgs) => Promise<unknown>;
  // Phase name for the final verification measurement (e.g. "verifyDeleted").
  verifyPhaseName: string;
  // Verify final state through the real read path.
  verify: (args: RecordReplayHookArgs) => Promise<RecordReplayVerification>;
};

export const runRecordReplayLifecycle = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordReplaySpec,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordReplayConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);

  let prepareMeasurement: Measurement<RecordReplayFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordReplayFixture(baseId, tableName, config, {
        perfCase,
        runner: spec.runner,
        seedCodeFiles: [spec.seedCodeFile],
      }),
    );
    const fixture = prepareMeasurement.result;
    // Preserve the exact artifact shape: record-delete passes `undefined` (no
    // replaySetup details), undo/redo pass a populated bag. So start undefined
    // and only create the bag when the spec actually has setup steps.
    let setupMeasurements: RecordReplaySetupMeasurements | undefined =
      spec.runSetup ? {} : undefined;
    let operationMeasurement: Measurement<unknown> | undefined;
    let verifyMeasurement: Measurement<RecordReplayVerification> | undefined;

    const hookArgs: RecordReplayHookArgs = {
      fixture,
      context,
      perfCase,
      config,
      windowId,
    };

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config),
      );

      await withRecordWindowId(windowId, async () => {
        if (spec.runSetup) {
          setupMeasurements = await spec.runSetup(hookArgs);
        }

        operationMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              spec.measuredOperation(hookArgs),
            ),
        );
      });

      verifyMeasurement = await measureAsync(spec.verifyPhaseName, () =>
        spec.verify(hookArgs),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildRecordReplayResult({
          config,
          operation: spec.operation,
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          setupMeasurements,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildRecordReplayResult({
      config,
      operation: spec.operation,
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      setupMeasurements,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    await cleanupRecordReplayFixture(baseId, prepareMeasurement, {
      config,
      context,
      perfCase,
      windowId,
    });
  }
};
