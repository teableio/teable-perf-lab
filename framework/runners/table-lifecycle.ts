import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  buildTableLifecycleSamplesResult,
  prepareTableLifecycleFixtures,
  type TableLifecycleCaseConfig,
  type TableLifecycleCleanupSample,
  type TableLifecycleFixtureSample,
  type TableLifecycleRequestSample,
  type TableLifecycleRunnerKind,
  type TableLifecycleVerifySample,
} from "./table-lifecycle.shared";

// Non-link sibling of `runTableLinkSamplesLifecycle`: the shared archive/restore
// sample loop for plain (linkless) tables. Both `table-delete` and
// `table-restore` prepare N reusable fixtures, run a per-sample request +
// verification, and aggregate through `buildTableLifecycleSamplesResult`; only
// the per-sample work, the success-only details, and the cleanup policy vary.

export type TableSamplesLifecycleState<TExtra extends object = object> = {
  fixtureSamples: TableLifecycleFixtureSample[];
  setupSamples: TableLifecycleVerifySample[];
  requestSamples: TableLifecycleRequestSample[];
  verifySamples: TableLifecycleVerifySample[];
  cleanupSamples: TableLifecycleCleanupSample[];
} & TExtra;

export type TableSamplesLifecycleRunArgs<TExtra extends object = object> = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: TableLifecycleCaseConfig;
  baseId: string;
  sample: TableLifecycleFixtureSample;
  state: TableSamplesLifecycleState<TExtra>;
};

export type TableSamplesLifecycleSpec<TExtra extends object = object> = {
  runner: TableLifecycleRunnerKind;
  includeSetupSamples?: boolean;
  includeCleanupSamples?: boolean;
  createState?: () => TExtra;
  runSample: (args: TableSamplesLifecycleRunArgs<TExtra>) => Promise<void>;
  buildDetails?: (args: {
    config: TableLifecycleCaseConfig;
    state: TableSamplesLifecycleState<TExtra>;
    error?: unknown;
  }) => Record<string, unknown>;
  cleanup?: (args: {
    perfCase: PerfCase;
    context: PerfRunContext;
    config: TableLifecycleCaseConfig;
    baseId: string;
    state: TableSamplesLifecycleState<TExtra>;
  }) => Promise<void>;
};

export const runTableSamplesLifecycle = async <TExtra extends object = object>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: TableSamplesLifecycleSpec<TExtra>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const state = {
    fixtureSamples: [],
    setupSamples: [],
    requestSamples: [],
    verifySamples: [],
    cleanupSamples: [],
    ...(spec.createState?.() ?? {}),
  } as TableSamplesLifecycleState<TExtra>;

  const buildResult = (error?: unknown) =>
    buildTableLifecycleSamplesResult({
      config,
      runner: spec.runner,
      fixtureSamples: state.fixtureSamples,
      requestSamples: state.requestSamples,
      setupSamples: spec.includeSetupSamples ? state.setupSamples : undefined,
      verifySamples: state.verifySamples,
      cleanupSamples: spec.includeCleanupSamples
        ? state.cleanupSamples
        : undefined,
      error,
      details: spec.buildDetails?.({ config, state, error }),
    });

  try {
    state.fixtureSamples = await prepareTableLifecycleFixtures(
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
