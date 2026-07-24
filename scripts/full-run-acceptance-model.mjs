const assertBoolean = (value, label) => {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
};

const assertOutcome = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

export const evaluateFullRunVerdict = ({
  fullRun,
  executeConclusion,
  seedAffinityOutcome = "skipped",
  resultAcceptanceOutcome = "skipped",
}) => {
  const resolvedFullRun = assertBoolean(fullRun, "fullRun");
  const evidence = {
    executeConclusion: assertOutcome(executeConclusion, "executeConclusion"),
    seedAffinityOutcome: assertOutcome(
      seedAffinityOutcome,
      "seedAffinityOutcome",
    ),
    resultAcceptanceOutcome: assertOutcome(
      resultAcceptanceOutcome,
      "resultAcceptanceOutcome",
    ),
  };
  const failures = [];

  if (evidence.executeConclusion !== "success") {
    failures.push({
      code: "execute-job",
      actual: evidence.executeConclusion,
      expected: "success",
    });
  }
  if (resolvedFullRun && evidence.seedAffinityOutcome !== "success") {
    failures.push({
      code: "seed-affinity",
      actual: evidence.seedAffinityOutcome,
      expected: "success",
    });
  }
  if (resolvedFullRun && evidence.resultAcceptanceOutcome !== "success") {
    failures.push({
      code: "result-acceptance",
      actual: evidence.resultAcceptanceOutcome,
      expected: "success",
    });
  }

  return {
    status: failures.length === 0 ? "success" : "failure",
    passed: failures.length === 0,
    fullRun: resolvedFullRun,
    evidence,
    failures,
  };
};
