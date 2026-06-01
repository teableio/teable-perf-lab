import authUserCase from "./cases/smoke/auth-user.case";
import formula10kCalcCase from "./cases/formula/10k-calc.case";
import formula10k5ConcurrentCase from "./cases/formula/10k-5-concurrent.case";
import conditionalLookup10kCase from "./cases/lookup/conditional-10k.case";
import recordPasteFlat10k20FieldsCopyPasteCase from "./cases/record-paste/flat-10k-20fields-copy-paste.case";
import recordPasteFlat10k4FieldsCopyPasteCase from "./cases/record-paste/flat-10k-4fields-copy-paste.case";
import recordPasteMixed10k20FieldsComplexCopyPasteCase from "./cases/record-paste/mixed-10k-20fields-complex-copy-paste.case";
import selectionClearFlat1k20FieldsCellClearStreamCase from "./cases/selection-clear/flat-1k-20fields-cell-clear-stream.case";
import recordDelete1kCase from "./cases/record-delete/delete-1k.case";
import recordRedoDelete1kCase from "./cases/record-redo/delete-1k.case";
import recordUndoDelete10kCase from "./cases/record-undo/delete-10k.case";
import type { PerfCase } from "./framework/types";

const cases = [
  authUserCase,
  formula10kCalcCase,
  formula10k5ConcurrentCase,
  conditionalLookup10kCase,
  selectionClearFlat1k20FieldsCellClearStreamCase,
  recordDelete1kCase,
  recordUndoDelete10kCase,
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
  ["selection-clear", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k-20fields", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/10k", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/10k-20fields", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  [
    "selection-clear/flat-10k-20fields-cell-clear-stream",
    "selection-clear/flat-1k-20fields-cell-clear-stream",
  ],
  ["record-delete", "record-delete/delete-1k"],
  ["delete/1k", "record-delete/delete-1k"],
  ["delete/10k", "record-delete/delete-1k"],
  ["record-delete/delete-10k", "record-delete/delete-1k"],
  ["record-undo", "record-undo/delete-10k"],
  ["undo/10k", "record-undo/delete-10k"],
  ["record-redo", "record-redo/delete-1k"],
  ["redo/1k", "record-redo/delete-1k"],
  ["redo/10k", "record-redo/delete-1k"],
  ["record-redo/delete-10k", "record-redo/delete-1k"],
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
