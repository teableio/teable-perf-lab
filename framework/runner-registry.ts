import { runConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { seedConditionalLookupCase } from "./runners/conditional-lookup.runner";
import { runConditionalRollupCase } from "./runners/conditional-rollup.runner";
import { seedConditionalRollupCase } from "./runners/conditional-rollup.runner";
import {
  runComputedChainMutationCase,
  seedComputedChainMutationCase,
} from "./runners/computed-chain-mutation.runner";
import {
  runCustomerUpsertComputedFlowCase,
  seedCustomerUpsertComputedFlowCase,
} from "./runners/customer-upsert-computed-flow.runner";
import {
  runConditionalQueryCase,
  seedConditionalQueryCase,
} from "./runners/conditional-query.runner";
import { runCsvImportCase } from "./runners/csv-import.runner";
import { seedCsvImportCase } from "./runners/csv-import.runner";
import { runDuplicateBaseCase } from "./runners/duplicate-base.runner";
import { seedDuplicateBaseCase } from "./runners/duplicate-base.runner";
import { runDuplicateTableCase } from "./runners/duplicate-table.runner";
import { seedDuplicateTableCase } from "./runners/duplicate-table.runner";
import {
  runDuplicateViewCase,
  seedDuplicateViewCase,
} from "./runners/duplicate-view.runner";
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
  PerfCaseFor,
  PerfRunContext,
  PerfRunnerKind,
  PerfRunResult,
} from "./types";

type RunnerLifecycleDriver =
  | "csv-import-lifecycle"
  | "duplicate-lifecycle"
  | "field-add-lifecycle"
  | "field-convert-lifecycle"
  | "field-delete-lifecycle"
  | "read-lifecycle"
  | "record-duplicate-lifecycle"
  | "record-mutation-lifecycle"
  | "record-replay-lifecycle"
  | "table-create-lifecycle"
  | "table-lifecycle"
  | "table-link-lifecycle";

type RunnerImplementationMetadata =
  | {
      mode: "lifecycle";
      drivers: readonly [RunnerLifecycleDriver, ...RunnerLifecycleDriver[]];
    }
  | {
      mode: "direct";
    };

type RecordReplayRunnerKind = Extract<
  PerfRunnerKind,
  "record-delete" | "record-undo" | "record-redo"
>;

export type RunnerOperation<K extends PerfRunnerKind> = (
  perfCase: PerfCaseFor<K>,
  context: PerfRunContext,
) => Promise<PerfRunResult>;

export type RunnerInventoryEntry<K extends PerfRunnerKind> = {
  readonly implementation: RunnerImplementationMetadata;
  readonly execute: RunnerOperation<K>;
  readonly seed: RunnerOperation<K>;
};

export type RunnerInventory = {
  readonly [K in PerfRunnerKind]: RunnerInventoryEntry<K>;
};

const seedlessRunner = async <K extends PerfRunnerKind>(
  perfCase: PerfCaseFor<K>,
): Promise<PerfRunResult> => ({
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

const seedRecordReplayRunner = async (
  perfCase: PerfCaseFor<RecordReplayRunnerKind>,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  if (!isRecordReplayRunnerKind(perfCase.runner)) {
    throw new Error(
      `Unsupported record replay seed runner: ${perfCase.runner}`,
    );
  }

  return seedRecordReplayCase(perfCase, context, perfCase.runner);
};

const runnerInventory = {
  "http-endpoint": {
    implementation: { mode: "direct" },
    execute: runHttpEndpointCase,
    seed: (perfCase) => seedlessRunner(perfCase),
  },
  "formula-table": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle"],
    },
    execute: runFormulaTableCase,
    seed: seedFormulaTableCase,
  },
  "conditional-lookup": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle"],
    },
    execute: runConditionalLookupCase,
    seed: seedConditionalLookupCase,
  },
  "conditional-rollup": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle"],
    },
    execute: runConditionalRollupCase,
    seed: seedConditionalRollupCase,
  },
  "conditional-query": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle", "record-mutation-lifecycle"],
    },
    execute: runConditionalQueryCase,
    seed: seedConditionalQueryCase,
  },
  "link-computed-propagation": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runLinkComputedPropagationCase,
    seed: seedLinkComputedPropagationCase,
  },
  "computed-chain-mutation": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runComputedChainMutationCase,
    seed: seedComputedChainMutationCase,
  },
  "customer-upsert-computed-flow": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runCustomerUpsertComputedFlowCase,
    seed: seedCustomerUpsertComputedFlowCase,
  },
  "lookup-search-index": {
    implementation: {
      mode: "lifecycle",
      drivers: ["read-lifecycle"],
    },
    execute: runLookupSearchIndexCase,
    seed: seedLookupSearchIndexCase,
  },
  "field-create": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle"],
    },
    execute: runFieldCreateCase,
    seed: seedFieldCreateCase,
  },
  "field-convert": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-convert-lifecycle"],
    },
    execute: runFieldConvertCase,
    seed: seedFieldConvertCase,
  },
  "field-convert-link": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-convert-lifecycle"],
    },
    execute: runFieldConvertLinkCase,
    seed: seedFieldConvertLinkCase,
  },
  "field-update": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runFieldUpdateCase,
    seed: seedFieldUpdateCase,
  },
  "field-delete": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-delete-lifecycle"],
    },
    execute: runFieldDeleteCase,
    seed: seedFieldDeleteCase,
  },
  "field-restore": {
    implementation: { mode: "direct" },
    execute: runFieldRestoreCase,
    seed: seedFieldRestoreCase,
  },
  "field-duplicate": {
    implementation: {
      mode: "lifecycle",
      drivers: ["field-add-lifecycle"],
    },
    execute: runFieldDuplicateCase,
    seed: seedFieldDuplicateCase,
  },
  "duplicate-table": {
    implementation: {
      mode: "lifecycle",
      drivers: ["duplicate-lifecycle"],
    },
    execute: runDuplicateTableCase,
    seed: seedDuplicateTableCase,
  },
  "duplicate-view": {
    implementation: { mode: "direct" },
    execute: runDuplicateViewCase,
    seed: seedDuplicateViewCase,
  },
  "duplicate-base": {
    implementation: {
      mode: "lifecycle",
      drivers: ["duplicate-lifecycle"],
    },
    execute: runDuplicateBaseCase,
    seed: seedDuplicateBaseCase,
  },
  "import-base": {
    implementation: { mode: "direct" },
    execute: runImportBaseCase,
    seed: seedImportBaseCase,
  },
  "record-delete-link": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-link-lifecycle"],
    },
    execute: runRecordDeleteLinkCase,
    seed: seedRecordDeleteLinkCase,
  },
  "table-create": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-create-lifecycle"],
    },
    execute: runTableCreateCase,
    seed: (perfCase) => seedlessRunner(perfCase),
  },
  "table-delete": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-lifecycle"],
    },
    execute: runTableDeleteCase,
    seed: seedTableDeleteCase,
  },
  "table-delete-link": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-link-lifecycle"],
    },
    execute: runTableDeleteLinkCase,
    seed: seedTableDeleteLinkCase,
  },
  "table-restore": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-lifecycle"],
    },
    execute: runTableRestoreCase,
    seed: seedTableRestoreCase,
  },
  "table-restore-link": {
    implementation: {
      mode: "lifecycle",
      drivers: ["table-link-lifecycle"],
    },
    execute: runTableRestoreLinkCase,
    seed: seedTableRestoreLinkCase,
  },
  "csv-import": {
    implementation: {
      mode: "lifecycle",
      drivers: ["csv-import-lifecycle"],
    },
    execute: runCsvImportCase,
    seed: seedCsvImportCase,
  },
  "form-submit": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runFormSubmitCase,
    seed: seedFormSubmitCase,
  },
  "record-paste": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordPasteCase,
    seed: (perfCase) => seedlessRunner(perfCase),
  },
  "record-read": {
    implementation: {
      mode: "lifecycle",
      drivers: ["read-lifecycle"],
    },
    execute: runRecordReadCase,
    seed: seedRecordReadCase,
  },
  "record-create": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordCreateCase,
    seed: seedRecordCreateCase,
  },
  "record-update": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordUpdateCase,
    seed: seedRecordUpdateCase,
  },
  "record-update-attachment": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordUpdateAttachmentCase,
    seed: seedRecordUpdateAttachmentCase,
  },
  "record-update-link": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordUpdateLinkCase,
    seed: seedRecordUpdateLinkCase,
  },
  "record-reorder": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordReorderCase,
    seed: seedRecordReorderCase,
  },
  "record-delete": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-replay-lifecycle"],
    },
    execute: runRecordDeleteCase,
    seed: (perfCase, context) => seedRecordReplayRunner(perfCase, context),
  },
  "record-delete-stream": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runRecordDeleteStreamCase,
    seed: seedRecordDeleteStreamCase,
  },
  "record-undo": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-replay-lifecycle"],
    },
    execute: runRecordUndoCase,
    seed: (perfCase, context) => seedRecordReplayRunner(perfCase, context),
  },
  "record-redo": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-replay-lifecycle"],
    },
    execute: runRecordRedoCase,
    seed: (perfCase, context) => seedRecordReplayRunner(perfCase, context),
  },
  "selection-clear": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-mutation-lifecycle"],
    },
    execute: runSelectionClearCase,
    seed: seedSelectionClearCase,
  },
  "selection-duplicate": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-duplicate-lifecycle"],
    },
    execute: runSelectionDuplicateCase,
    seed: seedSelectionDuplicateCase,
  },
  "record-duplicate-single": {
    implementation: {
      mode: "lifecycle",
      drivers: ["record-duplicate-lifecycle"],
    },
    execute: runRecordDuplicateSingleCase,
    seed: seedRecordDuplicateSingleCase,
  },
} satisfies RunnerInventory;

type RunnerOperationInput<T> = T extends (
  perfCase: infer Case,
  context: PerfRunContext,
) => Promise<PerfRunResult>
  ? Case
  : never;

type IsExactType<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;

type InvalidRunnerOperationKind = {
  [K in PerfRunnerKind]: IsExactType<
    RunnerOperationInput<(typeof runnerInventory)[K]["execute"]>,
    PerfCaseFor<K>
  > extends true
    ? IsExactType<
        RunnerOperationInput<(typeof runnerInventory)[K]["seed"]>,
        PerfCaseFor<K>
      > extends true
      ? never
      : K
    : K;
}[PerfRunnerKind];

type AssertNoInvalidRunnerOperation<T extends never> = T;
type RunnerInventoryOperationsAreExact =
  AssertNoInvalidRunnerOperation<InvalidRunnerOperationKind>;

type RunnerPhase = "execute" | "seed";

// TypeScript cannot preserve the relationship between a runtime object key and
// a mapped value after dynamic lookup. Keep that unavoidable assertion here at
// the dispatch seam; callers and runner inventory entries remain cast-free.
const dispatchRunner = <K extends PerfRunnerKind>(
  phase: RunnerPhase,
  perfCase: PerfCaseFor<K>,
  context: PerfRunContext,
  unsupportedMessage: string,
): Promise<PerfRunResult> => {
  const entry = runnerInventory[perfCase.runner] as
    | RunnerInventoryEntry<K>
    | undefined;
  if (!entry) {
    throw new Error(`${unsupportedMessage}: ${perfCase.runner}`);
  }

  return entry[phase](perfCase, context);
};

export const executeRegisteredRunner = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  dispatchRunner("execute", perfCase, context, "Unsupported perf runner");

export const seedRegisteredRunner = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  dispatchRunner("seed", perfCase, context, "Unsupported perf seed runner");
