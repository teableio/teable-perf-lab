import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { seedConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { seedCsvImportCase } from "./runners/csv-import.runner";
import { seedFieldConvertCase } from "./runners/field-convert.runner";
import { seedFieldCreateCase } from "./runners/field-create.runner";
import { seedFieldDeleteCase } from "./runners/field-delete.runner";
import { seedFieldDuplicateCase } from "./runners/field-duplicate.runner";
import { seedFormulaTableCase } from "./runners/formula-table.runner";
import { seedLookupSearchIndexCase } from "./runners/lookup-search-index.runner";
import { seedRecordCreateCase } from "./runners/record-create.runner";
import { seedRecordReorderCase } from "./runners/record-reorder.runner";
import { seedRecordUndoRedoCase } from "./runners/record-undo-redo.shared";
import { seedRecordUpdateCase } from "./runners/record-update.runner";
import { seedSelectionClearCase } from "./runners/selection-clear.runner";
import { writeTraceArtifacts } from "./trace-collector";
import type { PerfCase, PerfRunContext, PerfRunResult } from "./types";

const seedCaseByKind = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  switch (perfCase.runner) {
    case "formula-table":
      return seedFormulaTableCase(perfCase, context);
    case "conditional-lookup":
      return seedConditionalLookupCase(perfCase, context);
    case "lookup-search-index":
      return seedLookupSearchIndexCase(perfCase, context);
    case "field-create":
      return seedFieldCreateCase(perfCase, context);
    case "field-convert":
      return seedFieldConvertCase(perfCase, context);
    case "field-delete":
      return seedFieldDeleteCase(perfCase, context);
    case "field-duplicate":
      return seedFieldDuplicateCase(perfCase, context);
    case "csv-import":
      return seedCsvImportCase(perfCase, context);
    case "record-delete":
    case "record-undo":
    case "record-redo":
      return seedRecordUndoRedoCase(perfCase, context, perfCase.runner);
    case "record-update":
      return seedRecordUpdateCase(perfCase, context);
    case "record-reorder":
      return seedRecordReorderCase(perfCase, context);
    case "selection-clear":
      return seedSelectionClearCase(perfCase, context);
    case "record-create":
      return seedRecordCreateCase(perfCase, context);
    case "http-endpoint":
    case "record-paste":
      return {
        result: "skipped",
        metrics: {},
        thresholds: [],
        details: {
          skipped: true,
          reason: "This runner does not have a reusable seed phase.",
          runner: perfCase.runner,
        },
      };
    default:
      throw new Error(`Unsupported perf seed runner: ${perfCase.runner}`);
  }
};

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
};

const withTraceDetails = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  details: PerfRunResult["details"],
) => {
  const traceArtifacts = await writeTraceArtifacts({
    artifactDir: context.artifactDir,
    perfCase,
    engine: context.engine,
  });

  return {
    ...details,
    observability: {
      traces: traceArtifacts,
    },
  };
};

export const seedPerfCase = async (
  perfCase: PerfCase,
  appContext: Pick<PerfRunContext, "app" | "appUrl" | "cookie">,
) => {
  const startedAt = new Date();
  const started = performance.now();
  const context: PerfRunContext = {
    ...appContext,
    runId: process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`,
    engine: process.env.PERF_LAB_ENGINE ?? "seed",
    artifactDir: process.env.PERF_LAB_ARTIFACT_DIR,
  };

  try {
    const result = await seedCaseByKind(perfCase, context);
    const skipped = result.result === "skipped";
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: skipped ? "skipped" : "pass",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: result.metrics,
      thresholds: [],
      phases: result.phases,
      details: await withTraceDetails(context, perfCase, result.details),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
  } catch (error) {
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: {},
      thresholds: [],
      details: await withTraceDetails(context, perfCase, undefined),
      error: normalizeError(error),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    throw error;
  }
};
