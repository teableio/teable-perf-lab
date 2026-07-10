import { runConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { seedConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { runConditionalRollupCase } from "./runners/conditional-rollup.runner";
import { seedConditionalRollupCase } from "./runners/conditional-rollup.runner";
import { runCsvImportCase } from "./runners/csv-import.runner";
import { seedCsvImportCase } from "./runners/csv-import.runner";
import { runDuplicateBaseCase } from "./runners/duplicate-base.runner";
import { seedDuplicateBaseCase } from "./runners/duplicate-base.runner";
import { runDuplicateTableCase } from "./runners/duplicate-table.runner";
import { seedDuplicateTableCase } from "./runners/duplicate-table.runner";
import { runFieldConvertCase } from "./runners/field-convert.runner";
import { seedFieldConvertCase } from "./runners/field-convert.runner";
import { runFieldConvertLinkCase } from "./runners/field-convert-link.runner";
import { seedFieldConvertLinkCase } from "./runners/field-convert-link.runner";
import { runFieldCreateCase } from "./runners/field-create.runner";
import { seedFieldCreateCase } from "./runners/field-create.runner";
import { runFieldDeleteCase } from "./runners/field-delete.runner";
import { seedFieldDeleteCase } from "./runners/field-delete.runner";
import { runFieldRestoreCase } from "./runners/field-restore.runner";
import { seedFieldRestoreCase } from "./runners/field-restore.runner";
import { runFieldDuplicateCase } from "./runners/field-duplicate.runner";
import { seedFieldDuplicateCase } from "./runners/field-duplicate.runner";
import { runFieldUpdateCase } from "./runners/field-update.runner";
import { seedFieldUpdateCase } from "./runners/field-update.runner";
import { runFormulaTableCase } from "./runners/formula-table.runner";
import { seedFormulaTableCase } from "./runners/formula-table.runner";
import { runFormSubmitCase } from "./runners/form-submit.runner";
import { seedFormSubmitCase } from "./runners/form-submit.runner";
import { runHttpEndpointCase } from "./runners/http-endpoint.runner";
import { runImportBaseCase } from "./runners/import-base.runner";
import { seedImportBaseCase } from "./runners/import-base.runner";
import { runLinkComputedPropagationCase } from "./runners/link-computed-propagation.runner";
import { seedLinkComputedPropagationCase } from "./runners/link-computed-propagation.runner";
import { runLookupSearchIndexCase } from "./runners/lookup-search-index.runner";
import { seedLookupSearchIndexCase } from "./runners/lookup-search-index.runner";
import { runRecordCreateCase } from "./runners/record-create.runner";
import { seedRecordCreateCase } from "./runners/record-create.runner";
import { runRecordDeleteCase } from "./runners/record-delete.runner";
import {
  runRecordDeleteStreamCase,
  seedRecordDeleteStreamCase,
} from "./runners/record-delete-stream.runner";
import { runRecordDeleteLinkCase } from "./runners/record-delete-link.runner";
import { seedRecordDeleteLinkCase } from "./runners/record-delete-link.runner";
import { runRecordDuplicateSingleCase } from "./runners/record-duplicate-single.runner";
import { seedRecordDuplicateSingleCase } from "./runners/record-duplicate-single.runner";
import { runRecordPasteCase } from "./runners/record-paste.runner";
import { runRecordReadCase } from "./runners/record-read.runner";
import { seedRecordReadCase } from "./runners/record-read.runner";
import { runRecordRedoCase } from "./runners/record-redo.runner";
import { runRecordReorderCase } from "./runners/record-reorder.runner";
import { seedRecordReorderCase } from "./runners/record-reorder.runner";
import { runRecordUndoCase } from "./runners/record-undo.runner";
import { seedRecordReplayCase } from "./runners/record-replay.shared";
import { runRecordUpdateCase } from "./runners/record-update.runner";
import { seedRecordUpdateCase } from "./runners/record-update.runner";
import { runRecordUpdateAttachmentCase } from "./runners/record-update-attachment.runner";
import { seedRecordUpdateAttachmentCase } from "./runners/record-update-attachment.runner";
import { runRecordUpdateLinkCase } from "./runners/record-update-link.runner";
import { seedRecordUpdateLinkCase } from "./runners/record-update-link.runner";
import { runSelectionClearCase } from "./runners/selection-clear.runner";
import { seedSelectionClearCase } from "./runners/selection-clear.runner";
import { runSelectionDuplicateCase } from "./runners/selection-duplicate.runner";
import { seedSelectionDuplicateCase } from "./runners/selection-duplicate.runner";
import { runTableCreateCase } from "./runners/table-create.runner";
import { runTableDeleteCase } from "./runners/table-delete.runner";
import { seedTableDeleteCase } from "./runners/table-delete.runner";
import { runTableDeleteLinkCase } from "./runners/table-delete-link.runner";
import { seedTableDeleteLinkCase } from "./runners/table-delete-link.runner";
import { runTableRestoreCase } from "./runners/table-restore.runner";
import { seedTableRestoreCase } from "./runners/table-restore.runner";
import { runTableRestoreLinkCase } from "./runners/table-restore-link.runner";
import { seedTableRestoreLinkCase } from "./runners/table-restore-link.runner";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunnerKind,
  PerfRunResult,
} from "./types";

type RecordReplayRunnerKind = Extract<
  PerfRunnerKind,
  "record-delete" | "record-undo" | "record-redo"
>;

export type ExecuteEntry = (
  perfCase: PerfCase,
  context: PerfRunContext,
) => Promise<PerfRunResult>;

export type SeedEntry = (
  perfCase: PerfCase,
  context: PerfRunContext,
) => Promise<PerfRunResult>;

export type RunnerRegistryEntry = {
  execute: ExecuteEntry;
  seed: SeedEntry;
};

const seedlessRunner: SeedEntry = async (perfCase) => ({
  result: "skipped",
  metrics: {},
  thresholds: [],
  details: {
    skipped: true,
    reason: "This runner does not have a reusable seed phase.",
    runner: perfCase.runner,
  },
});

const isRecordReplayRunnerKind = (
  runner: PerfRunnerKind,
): runner is RecordReplayRunnerKind =>
  runner === "record-delete" ||
  runner === "record-undo" ||
  runner === "record-redo";

const seedRecordReplayRunner: SeedEntry = async (perfCase, context) => {
  if (!isRecordReplayRunnerKind(perfCase.runner)) {
    throw new Error(
      `Unsupported record replay seed runner: ${perfCase.runner}`,
    );
  }

  return seedRecordReplayCase(perfCase, context, perfCase.runner);
};

export const runnerRegistry: Record<PerfRunnerKind, RunnerRegistryEntry> = {
  "http-endpoint": {
    execute: (perfCase, context) => runHttpEndpointCase(perfCase, context),
    seed: seedlessRunner,
  },
  "formula-table": {
    execute: (perfCase, context) => runFormulaTableCase(perfCase, context),
    seed: (perfCase, context) => seedFormulaTableCase(perfCase, context),
  },
  "conditional-lookup": {
    execute: (perfCase, context) => runConditionalLookupCase(perfCase, context),
    seed: (perfCase, context) => seedConditionalLookupCase(perfCase, context),
  },
  "conditional-rollup": {
    execute: (perfCase, context) => runConditionalRollupCase(perfCase, context),
    seed: (perfCase, context) => seedConditionalRollupCase(perfCase, context),
  },
  "link-computed-propagation": {
    execute: (perfCase, context) =>
      runLinkComputedPropagationCase(perfCase, context),
    seed: (perfCase, context) =>
      seedLinkComputedPropagationCase(perfCase, context),
  },
  "lookup-search-index": {
    execute: (perfCase, context) => runLookupSearchIndexCase(perfCase, context),
    seed: (perfCase, context) => seedLookupSearchIndexCase(perfCase, context),
  },
  "field-create": {
    execute: (perfCase, context) => runFieldCreateCase(perfCase, context),
    seed: (perfCase, context) => seedFieldCreateCase(perfCase, context),
  },
  "field-convert": {
    execute: (perfCase, context) => runFieldConvertCase(perfCase, context),
    seed: (perfCase, context) => seedFieldConvertCase(perfCase, context),
  },
  "field-convert-link": {
    execute: (perfCase, context) => runFieldConvertLinkCase(perfCase, context),
    seed: (perfCase, context) => seedFieldConvertLinkCase(perfCase, context),
  },
  "field-update": {
    execute: (perfCase, context) => runFieldUpdateCase(perfCase, context),
    seed: (perfCase, context) => seedFieldUpdateCase(perfCase, context),
  },
  "field-delete": {
    execute: (perfCase, context) => runFieldDeleteCase(perfCase, context),
    seed: (perfCase, context) => seedFieldDeleteCase(perfCase, context),
  },
  "field-restore": {
    execute: (perfCase, context) => runFieldRestoreCase(perfCase, context),
    seed: (perfCase, context) => seedFieldRestoreCase(perfCase, context),
  },
  "field-duplicate": {
    execute: (perfCase, context) => runFieldDuplicateCase(perfCase, context),
    seed: (perfCase, context) => seedFieldDuplicateCase(perfCase, context),
  },
  "duplicate-table": {
    execute: (perfCase, context) => runDuplicateTableCase(perfCase, context),
    seed: (perfCase, context) => seedDuplicateTableCase(perfCase, context),
  },
  "duplicate-base": {
    execute: (perfCase, context) => runDuplicateBaseCase(perfCase, context),
    seed: (perfCase, context) => seedDuplicateBaseCase(perfCase, context),
  },
  "import-base": {
    execute: (perfCase, context) => runImportBaseCase(perfCase, context),
    seed: (perfCase, context) => seedImportBaseCase(perfCase, context),
  },
  "record-delete-link": {
    execute: (perfCase, context) => runRecordDeleteLinkCase(perfCase, context),
    seed: (perfCase, context) => seedRecordDeleteLinkCase(perfCase, context),
  },
  "table-create": {
    execute: (perfCase, context) => runTableCreateCase(perfCase, context),
    seed: seedlessRunner,
  },
  "table-delete": {
    execute: (perfCase, context) => runTableDeleteCase(perfCase, context),
    seed: (perfCase, context) => seedTableDeleteCase(perfCase, context),
  },
  "table-delete-link": {
    execute: (perfCase, context) => runTableDeleteLinkCase(perfCase, context),
    seed: (perfCase, context) => seedTableDeleteLinkCase(perfCase, context),
  },
  "table-restore": {
    execute: (perfCase, context) => runTableRestoreCase(perfCase, context),
    seed: (perfCase, context) => seedTableRestoreCase(perfCase, context),
  },
  "table-restore-link": {
    execute: (perfCase, context) => runTableRestoreLinkCase(perfCase, context),
    seed: (perfCase, context) => seedTableRestoreLinkCase(perfCase, context),
  },
  "csv-import": {
    execute: (perfCase, context) => runCsvImportCase(perfCase, context),
    seed: (perfCase, context) => seedCsvImportCase(perfCase, context),
  },
  "form-submit": {
    execute: (perfCase, context) => runFormSubmitCase(perfCase, context),
    seed: (perfCase, context) => seedFormSubmitCase(perfCase, context),
  },
  "record-paste": {
    execute: (perfCase, context) => runRecordPasteCase(perfCase, context),
    seed: seedlessRunner,
  },
  "record-read": {
    execute: (perfCase, context) => runRecordReadCase(perfCase, context),
    seed: (perfCase, context) => seedRecordReadCase(perfCase, context),
  },
  "record-create": {
    execute: (perfCase, context) => runRecordCreateCase(perfCase, context),
    seed: (perfCase, context) => seedRecordCreateCase(perfCase, context),
  },
  "record-update": {
    execute: (perfCase, context) => runRecordUpdateCase(perfCase, context),
    seed: (perfCase, context) => seedRecordUpdateCase(perfCase, context),
  },
  "record-update-attachment": {
    execute: (perfCase, context) =>
      runRecordUpdateAttachmentCase(perfCase, context),
    seed: (perfCase, context) =>
      seedRecordUpdateAttachmentCase(perfCase, context),
  },
  "record-update-link": {
    execute: (perfCase, context) => runRecordUpdateLinkCase(perfCase, context),
    seed: (perfCase, context) => seedRecordUpdateLinkCase(perfCase, context),
  },
  "record-reorder": {
    execute: (perfCase, context) => runRecordReorderCase(perfCase, context),
    seed: (perfCase, context) => seedRecordReorderCase(perfCase, context),
  },
  "record-delete": {
    execute: (perfCase, context) => runRecordDeleteCase(perfCase, context),
    seed: seedRecordReplayRunner,
  },
  "record-delete-stream": {
    execute: (perfCase, context) =>
      runRecordDeleteStreamCase(perfCase, context),
    seed: (perfCase, context) => seedRecordDeleteStreamCase(perfCase, context),
  },
  "record-undo": {
    execute: (perfCase, context) => runRecordUndoCase(perfCase, context),
    seed: seedRecordReplayRunner,
  },
  "record-redo": {
    execute: (perfCase, context) => runRecordRedoCase(perfCase, context),
    seed: seedRecordReplayRunner,
  },
  "selection-clear": {
    execute: (perfCase, context) => runSelectionClearCase(perfCase, context),
    seed: (perfCase, context) => seedSelectionClearCase(perfCase, context),
  },
  "selection-duplicate": {
    execute: (perfCase, context) =>
      runSelectionDuplicateCase(perfCase, context),
    seed: (perfCase, context) => seedSelectionDuplicateCase(perfCase, context),
  },
  "record-duplicate-single": {
    execute: (perfCase, context) =>
      runRecordDuplicateSingleCase(perfCase, context),
    seed: (perfCase, context) =>
      seedRecordDuplicateSingleCase(perfCase, context),
  },
};
