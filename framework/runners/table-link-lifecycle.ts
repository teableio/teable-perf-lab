import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordDeleteLinkCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  buildRecordWindowId,
  cleanupRecordReplayFixture,
  waitForRowsRestored,
  withRecordWindowId,
  type RecordReplayVerification,
} from "./record-replay.shared";
import {
  buildTableLifecycleSamplesResult,
  type TableLifecycleRequestSample,
  type TableLifecycleRunnerKind,
  type TableLifecycleVerifySample,
} from "./table-lifecycle.shared";
import {
  assertLinkCellSamples,
  permanentDeleteLinkFixture,
  prepareTableLinkFixture,
  prepareTableLinkFixtures,
  type TableLinkFixture,
  type TableLinkFixtureSample,
  type TableLinkLifecycleCaseConfig,
} from "./table-lifecycle-link.shared";

type RecordDeleteLinkRunnerKind = Extract<PerfRunnerKind, "record-delete-link">;

type TableLinkSampleRunnerKind = Extract<
  PerfRunnerKind,
  "table-delete-link" | "table-restore-link"
>;

export type RecordDeleteLinkLifecycleHookArgs = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: RecordDeleteLinkCaseConfig;
  fixture: TableLinkFixture;
  windowId: string;
};

export type RecordDeleteLinkLifecycleBuildResultArgs<TPrimary, TVerification> =
  {
    config: RecordDeleteLinkCaseConfig;
    fixture?: TableLinkFixture;
    prepareMeasurement?: Measurement<TableLinkFixture>;
    seedReadyMeasurement?: Measurement<RecordReplayVerification>;
    linkReadyMeasurement?: Measurement<
      Awaited<ReturnType<typeof assertLinkCellSamples>>
    >;
    operationMeasurement?: Measurement<TPrimary>;
    verifyMeasurement?: Measurement<TVerification>;
    error?: unknown;
  };

export type RecordDeleteLinkLifecycleSpec<TPrimary, TVerification> = {
  runner: RecordDeleteLinkRunnerKind;
  measuredOperation: (
    args: RecordDeleteLinkLifecycleHookArgs,
  ) => Promise<TPrimary>;
  verifyPhaseName: string;
  verify: (args: RecordDeleteLinkLifecycleHookArgs) => Promise<TVerification>;
  buildResult: (
    args: RecordDeleteLinkLifecycleBuildResultArgs<TPrimary, TVerification>,
  ) => PerfRunResult;
};

export const runRecordDeleteLinkLifecycle = async <TPrimary, TVerification>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: RecordDeleteLinkLifecycleSpec<TPrimary, TVerification>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordDeleteLinkCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<TableLinkFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
  let linkReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertLinkCellSamples>>>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareTableLinkFixture(baseId, tableName, config, perfCase, spec.runner),
    );
    const fixture = prepareMeasurement.result;
    let operationMeasurement: Measurement<TPrimary> | undefined;
    let verifyMeasurement: Measurement<TVerification> | undefined;
    const hookArgs: RecordDeleteLinkLifecycleHookArgs = {
      perfCase,
      context,
      config,
      fixture,
      windowId,
    };

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        waitForRowsRestored(fixture, config),
      );
      linkReadyMeasurement = await measureAsync("linkReady", () =>
        assertLinkCellSamples(fixture, config),
      );

      await withRecordWindowId(windowId, async () => {
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
        spec.buildResult({
          config,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          linkReadyMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      linkReadyMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    if (
      !isExecuteDbIsolated() &&
      prepareMeasurement?.result &&
      !prepareMeasurement.result.reusableSeed
    ) {
      await permanentDeleteLinkFixture(baseId, prepareMeasurement.result);
    } else {
      await cleanupRecordReplayFixture(baseId, prepareMeasurement, {
        config,
        context,
        perfCase,
        windowId,
      });
    }
    if (
      !isExecuteDbIsolated() &&
      prepareMeasurement?.result &&
      prepareMeasurement.result.reusableSeed
    ) {
      try {
        await waitForRowsRestored(prepareMeasurement.result, config);
        await assertLinkCellSamples(prepareMeasurement.result, config);
      } catch (error) {
        console.warn(
          `Deleting unrecoverable linked record-delete fixture ${prepareMeasurement.result.tableId}`,
          error,
        );
        await permanentDeleteLinkFixture(baseId, prepareMeasurement.result);
      }
    }
  }
};

export type TableLinkSamplesLifecycleState<TExtra extends object = object> = {
  fixtureSamples: TableLinkFixtureSample[];
  setupSamples: TableLifecycleVerifySample[];
  requestSamples: TableLifecycleRequestSample[];
  verifySamples: TableLifecycleVerifySample[];
} & TExtra;

export type TableLinkSamplesLifecycleRunArgs<TExtra extends object = object> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: TableLinkLifecycleCaseConfig;
  baseId: string;
  sample: TableLinkFixtureSample;
  state: TableLinkSamplesLifecycleState<TExtra>;
};

export type TableLinkSamplesLifecycleSpec<TExtra extends object = object> = {
  runner: TableLinkSampleRunnerKind;
  resultRunner: TableLifecycleRunnerKind;
  includeSetupSamples?: boolean;
  createState?: () => TExtra;
  runSample: (args: TableLinkSamplesLifecycleRunArgs<TExtra>) => Promise<void>;
  buildDetails?: (args: {
    config: TableLinkLifecycleCaseConfig;
    state: TableLinkSamplesLifecycleState<TExtra>;
    error?: unknown;
  }) => Record<string, unknown>;
  cleanup?: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    config: TableLinkLifecycleCaseConfig;
    baseId: string;
    state: TableLinkSamplesLifecycleState<TExtra>;
  }) => Promise<void>;
};

export const runTableLinkSamplesLifecycle = async <
  TExtra extends object = object,
>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: TableLinkSamplesLifecycleSpec<TExtra>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLinkLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const state = {
    fixtureSamples: [],
    setupSamples: [],
    requestSamples: [],
    verifySamples: [],
    ...(spec.createState?.() ?? {}),
  } as TableLinkSamplesLifecycleState<TExtra>;

  const buildResult = (error?: unknown) =>
    buildTableLifecycleSamplesResult({
      config,
      runner: spec.resultRunner,
      fixtureSamples: state.fixtureSamples,
      requestSamples: state.requestSamples,
      setupSamples: spec.includeSetupSamples ? state.setupSamples : undefined,
      verifySamples: state.verifySamples,
      error,
      details: spec.buildDetails?.({ config, state, error }),
    });

  try {
    state.fixtureSamples = await prepareTableLinkFixtures(
      baseId,
      config,
      perfCase,
      spec.runner,
    );

    try {
      for (const sample of state.fixtureSamples) {
        await spec.runSample({
          perfCase,
          context,
          config,
          baseId,
          sample,
          state,
        });
      }
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildResult(error),
      );
    }

    return buildResult();
  } finally {
    await spec.cleanup?.({ perfCase, context, config, baseId, state });
  }
};
