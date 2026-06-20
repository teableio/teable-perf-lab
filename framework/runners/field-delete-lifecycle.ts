import { measureAsync, type Measurement } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type {
  FieldDeleteCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  assertRowsRestored,
  buildRecordWindowId,
  prepareRecordUndoRedoFixture,
  withRecordWindowId,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

export type FieldDeleteLifecycleBuildResultArgs<TPrimary, TVerification> = {
  config: FieldDeleteCaseConfig;
  windowId?: string;
  fixture?: RecordUndoRedoFixture;
  prepareMeasurement?: Measurement<RecordUndoRedoFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  operationMeasurement?: Measurement<TPrimary>;
  verifyMeasurement?: Measurement<TVerification>;
  error?: unknown;
};

type FieldDeleteLifecycleRunArgs = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: FieldDeleteCaseConfig;
  fixture: RecordUndoRedoFixture;
};

export type FieldDeleteLifecycleSpec<TPrimary, TVerification, TOperationInput> =
  {
    seedCodeFile: URL;
    resolveOperationInput: (
      args: FieldDeleteLifecycleRunArgs,
    ) => Promise<TOperationInput> | TOperationInput;
    runOperation: (
      args: FieldDeleteLifecycleRunArgs & { operationInput: TOperationInput },
    ) => Promise<TPrimary>;
    verify: (args: FieldDeleteLifecycleRunArgs) => Promise<TVerification>;
    buildResult: (
      args: FieldDeleteLifecycleBuildResultArgs<TPrimary, TVerification>,
    ) => PerfRunResult;
    cleanup: (
      baseId: string,
      fixture: RecordUndoRedoFixture | undefined,
      options: { deleteAttempted: boolean },
    ) => Promise<void>;
  };

export const seedFieldDeleteLifecycle = async <
  TPrimary,
  TVerification,
  TOperationInput,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldDeleteLifecycleSpec<TPrimary, TVerification, TOperationInput>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareRecordUndoRedoFixture(baseId, tableName, config, {
      perfCase,
      runner: "field-delete",
      seedCodeFiles: [spec.seedCodeFile],
    }),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertRowsRestored(prepareMeasurement.result, config),
  );

  return spec.buildResult({
    config,
    windowId: `seed-${context.runId}-${perfCase.id}`,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

export const runFieldDeleteLifecycle = async <
  TPrimary,
  TVerification,
  TOperationInput,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: FieldDeleteLifecycleSpec<TPrimary, TVerification, TOperationInput>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let deleteAttempted = false;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordUndoRedoFixture(baseId, tableName, config, {
        perfCase,
        runner: "field-delete",
        seedCodeFiles: [spec.seedCodeFile],
      }),
    );
    const fixture = prepareMeasurement.result;
    let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
    let operationMeasurement: Measurement<TPrimary> | undefined;
    let verifyMeasurement: Measurement<TVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config),
      );
      const operationInput = await spec.resolveOperationInput({
        perfCase,
        context,
        config,
        fixture,
      });

      await withRecordWindowId(windowId, async () => {
        deleteAttempted = true;
        operationMeasurement = await measureAsync(config.threshold.metric, () =>
          spec.runOperation({
            perfCase,
            context,
            config,
            fixture,
            operationInput,
          }),
        );
      });

      verifyMeasurement = await measureAsync("verifyDeleted", () =>
        spec.verify({ perfCase, context, config, fixture }),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    await spec.cleanup(baseId, prepareMeasurement?.result, {
      deleteAttempted,
    });
  }
};
