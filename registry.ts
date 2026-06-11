import authUserCase from "./cases/smoke/auth-user.case";
import formula10kCalcCase from "./cases/formula/10k-calc.case";
import formula10k5ConcurrentCase from "./cases/formula/10k-5-concurrent.case";
import conditionalLookup10kCase from "./cases/lookup/conditional-10k.case";
import searchIndexOff10k20SearchFieldsCase from "./cases/search/search-index-off-10k-20search-fields.case";
import searchIndexOn10k20SearchFieldsCase from "./cases/search/search-index-on-10k-20search-fields.case";
import fieldCreateMixed10kCreate19FieldsCase from "./cases/field-create/mixed-10k-create-19-fields.case";
import fieldCreateSingleSelect1kOptionsCase from "./cases/field-create/single-select-1k-options.case";
import fieldDeleteMixed10kDelete19FieldsCase from "./cases/field-delete/mixed-10k-delete-19-fields.case";
import fieldDuplicateConditionalLookup10kCase from "./cases/field-duplicate/conditional-lookup-10k.case";
import csvImportMixed1k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-1k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-10k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsInplaceImportCase from "./cases/csv-import/mixed-10k-20fields-inplace-import.case";
import recordCreateMixed1k20FieldsBulkCreateCase from "./cases/record-create/mixed-1k-20fields-bulk-create.case";
import recordPasteFlat10k20FieldsCopyPasteCase from "./cases/record-paste/flat-10k-20fields-copy-paste.case";
import recordPasteFlat10k4FieldsCopyPasteCase from "./cases/record-paste/flat-10k-4fields-copy-paste.case";
import recordPasteMixed10k20FieldsComplexCopyPasteCase from "./cases/record-paste/mixed-10k-20fields-complex-copy-paste.case";
import recordReorder10kMoveLast1kToFrontCase from "./cases/record-reorder/10k-move-last-1k-to-front.case";
import recordUpdateMixed1k20FieldsBulkUpdateCase from "./cases/record-update/mixed-1k-20fields-bulk-update.case";
import selectionClearFlat1k20FieldsCellClearStreamCase from "./cases/selection-clear/flat-1k-20fields-cell-clear-stream.case";
import recordDelete1kCase from "./cases/record-delete/delete-1k.case";
import recordRedoDelete1kCase from "./cases/record-redo/delete-1k.case";
import recordUndoDelete1kCase from "./cases/record-undo/delete-1k.case";
import type { PerfCase } from "./framework/types";

const cases = [
  authUserCase,
  formula10kCalcCase,
  formula10k5ConcurrentCase,
  conditionalLookup10kCase,
  searchIndexOff10k20SearchFieldsCase,
  searchIndexOn10k20SearchFieldsCase,
  fieldCreateMixed10kCreate19FieldsCase,
  fieldCreateSingleSelect1kOptionsCase,
  fieldDeleteMixed10kDelete19FieldsCase,
  fieldDuplicateConditionalLookup10kCase,
  csvImportMixed1k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsInplaceImportCase,
  selectionClearFlat1k20FieldsCellClearStreamCase,
  recordDelete1kCase,
  recordCreateMixed1k20FieldsBulkCreateCase,
  recordUpdateMixed1k20FieldsBulkUpdateCase,
  recordReorder10kMoveLast1kToFrontCase,
  recordUndoDelete1kCase,
  recordRedoDelete1kCase,
  recordPasteFlat10k20FieldsCopyPasteCase,
  recordPasteFlat10k4FieldsCopyPasteCase,
  recordPasteMixed10k20FieldsComplexCopyPasteCase,
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
  ["lookup/search-index", "search/search-index-on-10k-20search-fields"],
  ["lookup/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["lookup/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search/search-index", "search/search-index-on-10k-20search-fields"],
  ["search/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["search/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search-index/lookup", "search/search-index-on-10k-20search-fields"],
  ["field-create", "field-create/single-select-1k-options"],
  ["field-create/19-fields", "field-create/mixed-10k-create-19-fields"],
  ["field-create/single-select", "field-create/single-select-1k-options"],
  ["select-options/1k", "field-create/single-select-1k-options"],
  ["field-delete", "field-delete/mixed-10k-delete-19-fields"],
  ["field-delete/19-fields", "field-delete/mixed-10k-delete-19-fields"],
  ["field-duplicate", "field-duplicate/conditional-lookup-10k"],
  ["field-duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
  ["duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
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
  ["selection-clear", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k-20fields", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["record-delete", "record-delete/delete-1k"],
  ["delete/1k", "record-delete/delete-1k"],
  ["record-create", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k-mixed-20fields", "record-create/mixed-1k-20fields-bulk-create"],
  ["record-update", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k-mixed-20fields", "record-update/mixed-1k-20fields-bulk-update"],
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
