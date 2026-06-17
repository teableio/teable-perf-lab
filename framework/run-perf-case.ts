import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { runConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { runCsvImportCase } from "./runners/csv-import.runner";
import { runDuplicateBaseCase } from "./runners/duplicate-base.runner";
import { runDuplicateTableCase } from "./runners/duplicate-table.runner";
import { runFieldConvertCase } from "./runners/field-convert.runner";
import { runFieldConvertLinkCase } from "./runners/field-convert-link.runner";
import { runFieldCreateCase } from "./runners/field-create.runner";
import { runFieldDeleteCase } from "./runners/field-delete.runner";
import { runFieldDuplicateCase } from "./runners/field-duplicate.runner";
import { runFieldUpdateCase } from "./runners/field-update.runner";
import { runFormulaTableCase } from "./runners/formula-table.runner";
import { runFormSubmitCase } from "./runners/form-submit.runner";
import { runHttpEndpointCase } from "./runners/http-endpoint.runner";
import { runImportBaseCase } from "./runners/import-base.runner";
import { runLinkComputedPropagationCase } from "./runners/link-computed-propagation.runner";
import { runLookupSearchIndexCase } from "./runners/lookup-search-index.runner";
import { runRecordDeleteCase } from "./runners/record-delete.runner";
import { runRecordDeleteLinkCase } from "./runners/record-delete-link.runner";
import { runRecordDuplicateSingleCase } from "./runners/record-duplicate-single.runner";
import { runRecordCreateCase } from "./runners/record-create.runner";
import { runRecordPasteCase } from "./runners/record-paste.runner";
import { runRecordReadCase } from "./runners/record-read.runner";
import { runRecordRedoCase } from "./runners/record-redo.runner";
import { runRecordReorderCase } from "./runners/record-reorder.runner";
import { runRecordUndoCase } from "./runners/record-undo.runner";
import { runRecordUpdateCase } from "./runners/record-update.runner";
import { runRecordUpdateAttachmentCase } from "./runners/record-update-attachment.runner";
import { runRecordUpdateLinkCase } from "./runners/record-update-link.runner";
import { runSelectionClearCase } from "./runners/selection-clear.runner";
import { runSelectionDuplicateCase } from "./runners/selection-duplicate.runner";
import { runTableCreateCase } from "./runners/table-create.runner";
import { runTableDeleteCase } from "./runners/table-delete.runner";
import { runTableDeleteLinkCase } from "./runners/table-delete-link.runner";
import { runTableRestoreCase } from "./runners/table-restore.runner";
import { runTableRestoreLinkCase } from "./runners/table-restore-link.runner";
import { resetPerfTraceRefs, writeTraceArtifacts } from "./trace-collector";
import { runWithWatchdog } from "./watchdog";
import { PerfRunDiagnosticError } from "./types";
import type {
  MetricThreshold,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "./types";

const runCaseByKind = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  switch (perfCase.runner) {
    case "http-endpoint":
      return runHttpEndpointCase(perfCase, context);
    case "formula-table":
      return runFormulaTableCase(perfCase, context);
    case "conditional-lookup":
      return runConditionalLookupCase(perfCase, context);
    case "link-computed-propagation":
      return runLinkComputedPropagationCase(perfCase, context);
    case "lookup-search-index":
      return runLookupSearchIndexCase(perfCase, context);
    case "field-create":
      return runFieldCreateCase(perfCase, context);
    case "field-convert":
      return runFieldConvertCase(perfCase, context);
    case "field-convert-link":
      return runFieldConvertLinkCase(perfCase, context);
    case "field-update":
      return runFieldUpdateCase(perfCase, context);
    case "field-delete":
      return runFieldDeleteCase(perfCase, context);
    case "field-duplicate":
      return runFieldDuplicateCase(perfCase, context);
    case "duplicate-table":
      return runDuplicateTableCase(perfCase, context);
    case "duplicate-base":
      return runDuplicateBaseCase(perfCase, context);
    case "import-base":
      return runImportBaseCase(perfCase, context);
    case "table-create":
      return runTableCreateCase(perfCase, context);
    case "table-delete":
      return runTableDeleteCase(perfCase, context);
    case "table-delete-link":
      return runTableDeleteLinkCase(perfCase, context);
    case "table-restore":
      return runTableRestoreCase(perfCase, context);
    case "table-restore-link":
      return runTableRestoreLinkCase(perfCase, context);
    case "csv-import":
      return runCsvImportCase(perfCase, context);
    case "form-submit":
      return runFormSubmitCase(perfCase, context);
    case "record-paste":
      return runRecordPasteCase(perfCase, context);
    case "record-read":
      return runRecordReadCase(perfCase, context);
    case "record-create":
      return runRecordCreateCase(perfCase, context);
    case "record-update":
      return runRecordUpdateCase(perfCase, context);
    case "record-update-attachment":
      return runRecordUpdateAttachmentCase(perfCase, context);
    case "record-update-link":
      return runRecordUpdateLinkCase(perfCase, context);
    case "record-reorder":
      return runRecordReorderCase(perfCase, context);
    case "record-delete":
      return runRecordDeleteCase(perfCase, context);
    case "record-delete-link":
      return runRecordDeleteLinkCase(perfCase, context);
    case "record-duplicate-single":
      return runRecordDuplicateSingleCase(perfCase, context);
    case "record-undo":
      return runRecordUndoCase(perfCase, context);
    case "record-redo":
      return runRecordRedoCase(perfCase, context);
    case "selection-clear":
      return runSelectionClearCase(perfCase, context);
    case "selection-duplicate":
      return runSelectionDuplicateCase(perfCase, context);
    default:
      throw new Error(`Unsupported perf runner: ${perfCase.runner}`);
  }
};

const evaluateThresholds = (
  metrics: Record<string, number>,
  thresholds: MetricThreshold[],
): Array<MetricThreshold & { passed: boolean; actual: number | null }> =>
  thresholds.map((threshold) => {
    const actual = metrics[threshold.metric];
    return {
      ...threshold,
      actual: typeof actual === "number" ? actual : null,
      passed: typeof actual === "number" && actual <= threshold.max,
    };
  });

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

export const runPerfCase = async (
  perfCase: PerfCase,
  appContext: Pick<PerfRunContext, "app" | "appUrl" | "cookie">,
) => {
  const startedAt = new Date();
  const started = performance.now();
  let payloadWritten = false;
  // Each case gets a fresh per-case ref budget (see resetPerfTraceRefs); the serial
  // spec shares one process across all cases, so leftover refs would otherwise let
  // the earliest cases exhaust PERF_LAB_TRACE_MAX_REFS and starve later ones.
  resetPerfTraceRefs();
  const context: PerfRunContext = {
    ...appContext,
    runId: process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`,
    engine: process.env.PERF_LAB_ENGINE ?? "local",
    artifactDir: process.env.PERF_LAB_ARTIFACT_DIR,
  };

  try {
    const result = perfCase.watchdogMs
      ? await runWithWatchdog(
          {
            watchdogMs: perfCase.watchdogMs,
            onAbort: (signal) => {
              context.signal = signal;
            },
          },
          () => runCaseByKind(perfCase, context),
        )
      : await runCaseByKind(perfCase, context);
    const thresholdResults = evaluateThresholds(
      result.metrics,
      result.thresholds,
    );
    const skipped = result.result === "skipped";
    const passed =
      skipped || thresholdResults.every((threshold) => threshold.passed);
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: skipped ? "skipped" : passed ? "pass" : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: result.metrics,
      thresholds: thresholdResults,
      phases: result.phases,
      details: await withTraceDetails(context, perfCase, result.details),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    payloadWritten = true;

    const failedThreshold = thresholdResults.find(
      (threshold) => !threshold.passed,
    );
    if (!skipped && failedThreshold) {
      throw new Error(
        `${failedThreshold.metric}=${failedThreshold.actual} ${failedThreshold.unit} exceeded ${failedThreshold.max} ${failedThreshold.unit}`,
      );
    }
  } catch (error) {
    if (payloadWritten) {
      throw error;
    }

    if (error instanceof PerfRunDiagnosticError) {
      const thresholdResults = evaluateThresholds(
        error.result.metrics,
        error.result.thresholds,
      );
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
        metrics: error.result.metrics,
        thresholds: thresholdResults,
        phases: error.result.phases,
        details: await withTraceDetails(
          context,
          perfCase,
          error.result.details,
        ),
        error: normalizeError(error),
      };

      await writePerfArtifacts(context.artifactDir, perfCase, payload);
      throw error;
    }

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
