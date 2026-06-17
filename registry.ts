import authUserCase from "./cases/smoke/auth-user.case";
import formula10kCalcCase from "./cases/formula/10k-calc.case";
import formula10k5ConcurrentCase from "./cases/formula/10k-5-concurrent.case";
import conditionalLookup10kCase from "./cases/lookup/conditional-10k.case";
import dualLinkComputedFirstLink4kCase from "./cases/lookup/dual-link-computed-first-link-4k.case";
import dualLinkComputedRepoint2kCase from "./cases/lookup/dual-link-computed-repoint-2k.case";
import searchIndexOff10k20SearchFieldsCase from "./cases/search/search-index-off-10k-20search-fields.case";
import searchIndexOn10k20SearchFieldsCase from "./cases/search/search-index-on-10k-20search-fields.case";
import fieldCreateFormula10kCreate5FieldsCase from "./cases/field-create/10k-create-5-formula-fields.case";
import fieldCreateMixed10kCreate19FieldsCase from "./cases/field-create/mixed-10k-create-19-fields.case";
import fieldCreateSimple10kCreate5FieldsCase from "./cases/field-create/10k-create-5-simple-fields.case";
import fieldCreateSingleSelect1kOptionsCase from "./cases/field-create/single-select-1k-options.case";
import fieldConvert10kMultiSelectToTextCase from "./cases/field-convert/10k-multi-select-to-text.case";
import fieldConvert10kTextToFormulaCase from "./cases/field-convert/10k-text-to-formula.case";
import fieldConvert10kLinkToTextCase from "./cases/field-convert/10k-link-to-text.case";
import fieldConvert10kTextToLinkCase from "./cases/field-convert/10k-text-to-link.case";
import fieldDeleteMixed10kDelete19FieldsCase from "./cases/field-delete/mixed-10k-delete-19-fields.case";
import fieldDuplicateConditionalLookup10kCase from "./cases/field-duplicate/conditional-lookup-10k.case";
import fieldUpdate10kSelectOptionRenameComputedCascadeCase from "./cases/field-update/v2-only-10k-select-option-rename-computed-cascade.case";
import duplicateTable10k20FCase from "./cases/duplicate-table/10k-20f.case";
import duplicateTable10k25F5FormulaCase from "./cases/duplicate-table/10k-25f-5formula.case";
import duplicateBase10k3TablesLink2WorkflowCase from "./cases/duplicate-base/10k-3tables-link-2workflow.case";
import duplicateBase10k3TablesLink2WorkflowStreamCase from "./cases/duplicate-base/10k-3tables-link-2workflow-stream.case";
import importBaseV2OnlySimple1x1kTableStreamCase from "./cases/import-base/v2-only-simple-1x1k-table-stream.case";
import importBaseV2OnlyComplex3x10k3Tables2WorkflowStreamCase from "./cases/import-base/v2-only-complex-3x10k-3tables-2workflow-stream.case";
import importBaseV2OnlyUserT2377TeaStreamCase from "./cases/import-base/v2-only-user-t2377-tea-stream.case";
import exportBase10k3TablesLink2WorkflowStreamCase from "./cases/export-base/10k-3tables-link-2workflow-stream.case";
import tableCreate10x20FNoRecordsCase from "./cases/table-create/10x-20f-no-records.case";
import tableCreate1x20F1kRecordsCase from "./cases/table-create/1x-20f-1k-records.case";
import tableDelete10k20FCase from "./cases/table-delete/10k-20f.case";
import tableDelete10k20FLinkDetachCase from "./cases/table-delete/10k-20f-link-detach.case";
import tableRestore10k20FCase from "./cases/table-restore/10k-20f.case";
import tableRestore10k20FLink1kCase from "./cases/table-restore/10k-20f-link-1k.case";
import csvImportMixed1k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-1k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-10k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsInplaceImportCase from "./cases/csv-import/mixed-10k-20fields-inplace-import.case";
import formSubmitSequential200Case from "./cases/form-submit/sequential-200.case";
import recordCreateMixed1k20FieldsBulkCreateCase from "./cases/record-create/mixed-1k-20fields-bulk-create.case";
import recordDuplicateGridBlockDuplicate1kCase from "./cases/record-duplicate/grid-block-duplicate-1k.case";
import recordDuplicateSingleRecordSequential100Case from "./cases/record-duplicate/single-record-sequential-100.case";
import recordRead10k50Fields10x1kPagesCase from "./cases/record-read/10k-50fields-10x1k-pages.case";
import recordRead10k50FieldsFilterSortGroupbyOverheadCase from "./cases/record-read/10k-50fields-filter-sort-groupby-overhead.case";
import recordPasteFlat10k20FieldsCopyPasteCase from "./cases/record-paste/flat-10k-20fields-copy-paste.case";
import recordPasteFlat10k4FieldsCopyPasteCase from "./cases/record-paste/flat-10k-4fields-copy-paste.case";
import recordPasteMixed10k20FieldsComplexCopyPasteCase from "./cases/record-paste/mixed-10k-20fields-complex-copy-paste.case";
import selectionPaste10kExpandRowsAndFieldsStreamCase from "./cases/selection-paste/10k-expand-rows-and-fields-stream.case";
import recordReorder10kMoveLast1kToFrontCase from "./cases/record-reorder/10k-move-last-1k-to-front.case";
import recordUpdateMixed1k20FieldsBulkUpdateCase from "./cases/record-update/mixed-1k-20fields-bulk-update.case";
import recordUpdateAttachmentInsert100Case from "./cases/record-update/attachment-insert-100.case";
import recordUpdate1kLinkCellsBulkUpdateCase from "./cases/record-update/1k-link-cells-bulk-update.case";
import selectionClearFlat1k20FieldsCellClearStreamCase from "./cases/selection-clear/flat-1k-20fields-cell-clear-stream.case";
import recordDelete1kCase from "./cases/record-delete/delete-1k.case";
import recordDeleteLinkTrash1kCase from "./cases/record-delete/link-trash-1k.case";
import recordRedoDelete1kCase from "./cases/record-redo/delete-1k.case";
import recordUndoDelete1kCase from "./cases/record-undo/delete-1k.case";
import type { PerfCase } from "./framework/types";

const cases = [
  authUserCase,
  formula10kCalcCase,
  formula10k5ConcurrentCase,
  conditionalLookup10kCase,
  dualLinkComputedFirstLink4kCase,
  dualLinkComputedRepoint2kCase,
  searchIndexOff10k20SearchFieldsCase,
  searchIndexOn10k20SearchFieldsCase,
  fieldCreateSimple10kCreate5FieldsCase,
  fieldCreateFormula10kCreate5FieldsCase,
  fieldCreateMixed10kCreate19FieldsCase,
  fieldCreateSingleSelect1kOptionsCase,
  fieldConvert10kMultiSelectToTextCase,
  fieldConvert10kTextToFormulaCase,
  fieldConvert10kLinkToTextCase,
  fieldConvert10kTextToLinkCase,
  fieldUpdate10kSelectOptionRenameComputedCascadeCase,
  fieldDeleteMixed10kDelete19FieldsCase,
  fieldDuplicateConditionalLookup10kCase,
  duplicateTable10k20FCase,
  duplicateTable10k25F5FormulaCase,
  duplicateBase10k3TablesLink2WorkflowCase,
  duplicateBase10k3TablesLink2WorkflowStreamCase,
  importBaseV2OnlySimple1x1kTableStreamCase,
  importBaseV2OnlyComplex3x10k3Tables2WorkflowStreamCase,
  importBaseV2OnlyUserT2377TeaStreamCase,
  exportBase10k3TablesLink2WorkflowStreamCase,
  tableCreate10x20FNoRecordsCase,
  tableCreate1x20F1kRecordsCase,
  tableDelete10k20FCase,
  tableDelete10k20FLinkDetachCase,
  tableRestore10k20FCase,
  tableRestore10k20FLink1kCase,
  csvImportMixed1k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsInplaceImportCase,
  formSubmitSequential200Case,
  selectionClearFlat1k20FieldsCellClearStreamCase,
  recordDelete1kCase,
  recordDeleteLinkTrash1kCase,
  recordRead10k50Fields10x1kPagesCase,
  recordRead10k50FieldsFilterSortGroupbyOverheadCase,
  recordCreateMixed1k20FieldsBulkCreateCase,
  recordDuplicateGridBlockDuplicate1kCase,
  recordDuplicateSingleRecordSequential100Case,
  recordUpdateMixed1k20FieldsBulkUpdateCase,
  recordUpdateAttachmentInsert100Case,
  recordUpdate1kLinkCellsBulkUpdateCase,
  recordReorder10kMoveLast1kToFrontCase,
  recordUndoDelete1kCase,
  recordRedoDelete1kCase,
  recordPasteFlat10k20FieldsCopyPasteCase,
  recordPasteFlat10k4FieldsCopyPasteCase,
  recordPasteMixed10k20FieldsComplexCopyPasteCase,
  selectionPaste10kExpandRowsAndFieldsStreamCase,
] satisfies PerfCase[];

const caseById = new Map(cases.map((perfCase) => [perfCase.id, perfCase]));
const caseAliases = new Map([
  ["smoke", "smoke/auth-user"],
  ["auth-user", "smoke/auth-user"],
  ["formula", "formula/10k-calc"],
  ["formula/10k", "formula/10k-calc"],
  ["formula/10k-5", "formula/10k-5-concurrent"],
  ["formula/10k/concurrent", "formula/10k-5-concurrent"],
  ["lookup/conditional", "lookup/conditional-10k"],
  ["conditional-lookup", "lookup/conditional-10k"],
  ["lookup/dual-link-first-link", "lookup/dual-link-computed-first-link-4k"],
  ["lookup/dual-link-repoint", "lookup/dual-link-computed-repoint-2k"],
  ["lookup/search-index", "search/search-index-on-10k-20search-fields"],
  ["lookup/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["lookup/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search/search-index", "search/search-index-on-10k-20search-fields"],
  ["search/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["search/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search-index/lookup", "search/search-index-on-10k-20search-fields"],
  ["field-create", "field-create/10k-create-5-simple-fields"],
  ["field-create/5-simple", "field-create/10k-create-5-simple-fields"],
  ["field-create/simple", "field-create/10k-create-5-simple-fields"],
  ["field-create/5-formula", "field-create/10k-create-5-formula-fields"],
  ["field-create/formula", "field-create/10k-create-5-formula-fields"],
  ["field-create/19-fields", "field-create/mixed-10k-create-19-fields"],
  ["field-create/single-select", "field-create/single-select-1k-options"],
  ["select-options/1k", "field-create/single-select-1k-options"],
  ["field-convert", "field-convert/10k-multi-select-to-text"],
  ["field-convert/select-to-text", "field-convert/10k-multi-select-to-text"],
  ["field-convert/text-to-formula", "field-convert/10k-text-to-formula"],
  ["convert/select-to-text", "field-convert/10k-multi-select-to-text"],
  ["convert/text-to-formula", "field-convert/10k-text-to-formula"],
  ["field-convert/link-to-text", "field-convert/10k-link-to-text"],
  ["field-convert/text-to-link", "field-convert/10k-text-to-link"],
  ["convert/link-to-text", "field-convert/10k-link-to-text"],
  ["convert/text-to-link", "field-convert/10k-text-to-link"],
  [
    "field-update",
    "field-update/v2-only-10k-select-option-rename-computed-cascade",
  ],
  [
    "field-update/select-rename",
    "field-update/v2-only-10k-select-option-rename-computed-cascade",
  ],
  ["field-delete", "field-delete/mixed-10k-delete-19-fields"],
  ["field-delete/19-fields", "field-delete/mixed-10k-delete-19-fields"],
  ["field-duplicate", "field-duplicate/conditional-lookup-10k"],
  ["field-duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
  ["duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
  ["duplicate-table", "duplicate-table/10k-20f"],
  ["duplicate-table/mixed", "duplicate-table/10k-20f"],
  ["duplicate-table/10k-20fields", "duplicate-table/10k-20f"],
  ["duplicate-table/complex", "duplicate-table/10k-25f-5formula"],
  ["duplicate-base", "duplicate-base/10k-3tables-link-2workflow"],
  ["duplicate-base/3tables", "duplicate-base/10k-3tables-link-2workflow"],
  ["duplicate-base/stream", "duplicate-base/10k-3tables-link-2workflow-stream"],
  [
    "import-base/stream",
    "import-base/v2-only-complex-3x10k-3tables-2workflow-stream",
  ],
  ["import-base/simple", "import-base/v2-only-simple-1x1k-table-stream"],
  [
    "import-base/complex",
    "import-base/v2-only-complex-3x10k-3tables-2workflow-stream",
  ],
  ["import-base/t2377", "import-base/v2-only-user-t2377-tea-stream"],
  ["import-base/user-t2377", "import-base/v2-only-user-t2377-tea-stream"],
  ["export-base/stream", "export-base/10k-3tables-link-2workflow-stream"],
  ["table-create", "table-create/10x-20f-no-records"],
  ["table-create/10x", "table-create/10x-20f-no-records"],
  ["table-create/1k-records", "table-create/1x-20f-1k-records"],
  ["table-create/inline-records", "table-create/1x-20f-1k-records"],
  ["table-delete", "table-delete/10k-20f"],
  ["table-delete/10k", "table-delete/10k-20f"],
  ["table-delete/link-detach", "table-delete/10k-20f-link-detach"],
  ["table-delete/link", "table-delete/10k-20f-link-detach"],
  ["table-restore", "table-restore/10k-20f"],
  ["table-restore/10k", "table-restore/10k-20f"],
  ["table-restore/link", "table-restore/10k-20f-link-1k"],
  ["table-restore/10k-link", "table-restore/10k-20f-link-1k"],
  ["csv-import", "csv-import/mixed-10k-20fields-inplace-import"],
  ["csv-import/10k", "csv-import/mixed-10k-20fields-inplace-import"],
  ["csv-import/10k-20fields", "csv-import/mixed-10k-20fields-inplace-import"],
  [
    "csv-import/create-table",
    "csv-import/mixed-1k-20fields-create-table-import",
  ],
  [
    "csv-import/1k-create-table",
    "csv-import/mixed-1k-20fields-create-table-import",
  ],
  [
    "csv-import/10k-create-table",
    "csv-import/mixed-10k-20fields-create-table-import",
  ],
  ["form-submit", "form-submit/sequential-200"],
  ["form-submit/200", "form-submit/sequential-200"],
  ["selection-clear", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k-20fields", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["record-delete", "record-delete/delete-1k"],
  ["delete/1k", "record-delete/delete-1k"],
  ["record-delete/link", "record-delete/link-trash-1k"],
  ["delete/link-trash", "record-delete/link-trash-1k"],
  ["record-read", "record-read/10k-50fields-10x1k-pages"],
  ["get-records", "record-read/10k-50fields-10x1k-pages"],
  ["get-records/10k", "record-read/10k-50fields-10x1k-pages"],
  ["read/10k-50fields", "record-read/10k-50fields-10x1k-pages"],
  [
    "record-read/query-overhead",
    "record-read/10k-50fields-filter-sort-groupby-overhead",
  ],
  [
    "get-records/query-overhead",
    "record-read/10k-50fields-filter-sort-groupby-overhead",
  ],
  ["record-create", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k-mixed-20fields", "record-create/mixed-1k-20fields-bulk-create"],
  ["record-duplicate", "record-duplicate/grid-block-duplicate-1k"],
  ["record-duplicate/grid", "record-duplicate/grid-block-duplicate-1k"],
  ["duplicate-record/grid", "record-duplicate/grid-block-duplicate-1k"],
  ["record-duplicate/single", "record-duplicate/single-record-sequential-100"],
  ["duplicate-record/single", "record-duplicate/single-record-sequential-100"],
  ["record-update", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k-mixed-20fields", "record-update/mixed-1k-20fields-bulk-update"],
  ["record-update/attachment", "record-update/attachment-insert-100"],
  ["update/attachment-100", "record-update/attachment-insert-100"],
  ["record-update/link", "record-update/1k-link-cells-bulk-update"],
  ["update/1k-link", "record-update/1k-link-cells-bulk-update"],
  ["record-reorder", "record-reorder/10k-move-last-1k-to-front"],
  ["reorder/10k-last-1k", "record-reorder/10k-move-last-1k-to-front"],
  ["reorder/last-1k-front", "record-reorder/10k-move-last-1k-to-front"],
  ["record-undo", "record-undo/delete-1k"],
  ["undo/1k", "record-undo/delete-1k"],
  ["record-redo", "record-redo/delete-1k"],
  ["redo/1k", "record-redo/delete-1k"],
  ["record-paste", "record-paste/flat-10k-4fields-copy-paste"],
  ["paste/10k", "record-paste/flat-10k-4fields-copy-paste"],
  ["paste/10k-20fields", "record-paste/flat-10k-20fields-copy-paste"],
  [
    "paste/10k-mixed-20fields",
    "record-paste/mixed-10k-20fields-complex-copy-paste",
  ],
  ["paste/10k-complex", "record-paste/mixed-10k-20fields-complex-copy-paste"],
  [
    "selection-paste/expand-stream",
    "selection-paste/10k-expand-rows-and-fields-stream",
  ],
  ["paste/expand-stream", "selection-paste/10k-expand-rows-and-fields-stream"],
]);

export const listPerfCaseIds = () => cases.map((perfCase) => perfCase.id);

export const resolvePerfCaseIds = (
  caseFilter = "smoke/auth-user",
): string[] => {
  const trimmed = caseFilter.trim();
  if (!trimmed || trimmed === "all" || trimmed === "*") {
    return listPerfCaseIds();
  }

  const caseIds = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((caseId) => caseAliases.get(caseId) ?? caseId);

  const unknownCaseIds = caseIds.filter((caseId) => !caseById.has(caseId));
  if (unknownCaseIds.length > 0) {
    throw new Error(
      `Unsupported PERF_LAB_CASE_FILTER: ${unknownCaseIds.join(
        ", ",
      )}. Available cases: ${listPerfCaseIds().join(", ")}, or "all".`,
    );
  }

  return [...new Set(caseIds)];
};

export const getPerfCase = (caseId: string): PerfCase => {
  const canonicalCaseId = caseAliases.get(caseId) ?? caseId;
  const perfCase = caseById.get(canonicalCaseId);
  if (perfCase) {
    return perfCase;
  }

  throw new Error(
    `Unsupported PERF_LAB_CASE_ID: ${caseId}. Available cases: ${cases
      .map(({ id }) => id)
      .join(", ")}`,
  );
};

export const listPerfCases = (caseFilter?: string) =>
  resolvePerfCaseIds(caseFilter).map(getPerfCase);
