import authUserCase from "./smoke/auth-user.case";
import formula10kCalcCase from "./formula/10k-calc.case";
import type { PerfCase } from "./framework/types";

const cases = [authUserCase, formula10kCalcCase] satisfies PerfCase[];

const caseById = new Map(cases.map((perfCase) => [perfCase.id, perfCase]));
const caseAliases = new Map([
  ["smoke", "smoke/auth-user"],
  ["auth-user", "smoke/auth-user"],
  ["formula", "formula/10k-calc"],
  ["formula/10k", "formula/10k-calc"],
]);

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
