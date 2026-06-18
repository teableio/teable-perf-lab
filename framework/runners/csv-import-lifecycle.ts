import { measureAsync } from "../metrics";
import { PerfRunDiagnosticError } from "../types";
import type {
  CsvImportCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";

export type CsvImportMeasurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type CsvImportBaseArgs = {
  perfCase: PerfCase;
  context: PerfRunContext;
  config: CsvImportCaseConfig;
  baseId: string;
};

type CsvImportPrepareArgs = CsvImportBaseArgs & {
  tableName: string;
};

type CsvImportFixtureArgs<TFixture> = CsvImportBaseArgs & {
  fixture: TFixture;
};

type CsvImportBuildResultArgs<TFixture, TPrimary, TSeedReady> = {
  config: CsvImportCaseConfig;
  prepareMeasurement?: CsvImportMeasurement<TFixture>;
  seedReadyMeasurement?: CsvImportMeasurement<TSeedReady>;
  primaryMeasurement?: CsvImportMeasurement<TPrimary>;
  error?: unknown;
};

export type CsvImportLifecycleSpec<TFixture, TPrimary, TSeedReady> = {
  hasReusableSeed: (config: CsvImportCaseConfig) => boolean;
  seedlessResult: (perfCase: PerfCase) => PerfRunResult;
  prepareExecute: (args: CsvImportPrepareArgs) => Promise<TFixture>;
  prepareSeed: (args: CsvImportPrepareArgs) => Promise<TFixture>;
  execute: (args: CsvImportFixtureArgs<TFixture>) => Promise<TPrimary>;
  seedReady: (args: CsvImportFixtureArgs<TFixture>) => Promise<TSeedReady>;
  buildResult: (
    args: CsvImportBuildResultArgs<TFixture, TPrimary, TSeedReady>,
  ) => PerfRunResult;
  cleanup: (
    args: CsvImportBaseArgs & {
      prepareMeasurement?: CsvImportMeasurement<TFixture>;
    },
  ) => Promise<void>;
};

export const runCsvImportLifecycle = async <TFixture, TPrimary, TSeedReady>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: CsvImportLifecycleSpec<TFixture, TPrimary, TSeedReady>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as CsvImportCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: CsvImportMeasurement<TFixture> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      spec.prepareExecute({ perfCase, context, config, baseId, tableName }),
    );
    let primaryMeasurement: CsvImportMeasurement<TPrimary> | undefined;

    try {
      primaryMeasurement = await measureAsync(config.threshold.metric, () =>
        spec.execute({
          perfCase,
          context,
          config,
          baseId,
          fixture: prepareMeasurement.result,
        }),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        spec.buildResult({
          config,
          prepareMeasurement,
          primaryMeasurement,
          error,
        }),
      );
    }

    return spec.buildResult({
      config,
      prepareMeasurement,
      primaryMeasurement,
    });
  } finally {
    await spec.cleanup({
      perfCase,
      context,
      config,
      baseId,
      prepareMeasurement,
    });
  }
};

export const seedCsvImportLifecycle = async <TFixture, TPrimary, TSeedReady>(
  perfCase: PerfCase,
  context: PerfRunContext,
  spec: CsvImportLifecycleSpec<TFixture, TPrimary, TSeedReady>,
): Promise<PerfRunResult> => {
  const config = perfCase.config as CsvImportCaseConfig;
  const baseId = globalThis.testConfig.baseId;

  if (!spec.hasReusableSeed(config)) {
    return spec.seedlessResult(perfCase);
  }

  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    spec.prepareSeed({ perfCase, context, config, baseId, tableName }),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    spec.seedReady({
      perfCase,
      context,
      config,
      baseId,
      fixture: prepareMeasurement.result,
    }),
  );

  return spec.buildResult({
    config,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};
