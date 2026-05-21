const allCases = [
  "smoke/auth-user",
  "formula/10k-calc",
  "formula/10k-5-concurrent",
  "lookup/conditional-10k",
];

const aliases = new Map([
  ["smoke", "smoke/auth-user"],
  ["auth-user", "smoke/auth-user"],
  ["formula", "formula/10k-calc"],
  ["formula/10k", "formula/10k-calc"],
  ["formula/10k-5", "formula/10k-5-concurrent"],
  ["formula/10k/concurrent", "formula/10k-5-concurrent"],
  ["lookup/conditional", "lookup/conditional-10k"],
  ["conditional-lookup", "lookup/conditional-10k"],
]);

const sanitizeCaseId = (caseId) => caseId.replace(/[^a-zA-Z0-9_.-]+/g, "-");

const parseCaseFilter = (caseFilter) => {
  const trimmed = caseFilter.trim();
  if (!trimmed || trimmed === "all" || trimmed === "*") {
    return allCases;
  }

  const caseIds = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((caseId) => aliases.get(caseId) ?? caseId);

  const unknownCaseIds = caseIds.filter((caseId) => !allCases.includes(caseId));
  if (unknownCaseIds.length > 0) {
    throw new Error(
      `Unsupported case_filter: ${unknownCaseIds.join(
        ", ",
      )}. Available cases: ${allCases.join(", ")}, or "all".`,
    );
  }

  return [...new Set(caseIds)];
};

const caseFilter = process.env.PERF_LAB_CASE_FILTER ?? "smoke/auth-user";
const caseIds = parseCaseFilter(caseFilter);
const include = caseIds.flatMap((caseId) => {
  const artifactCase = sanitizeCaseId(caseId);
  return [
    {
      case_id: caseId,
      artifact_case: artifactCase,
      engine: "v1",
      force_v2_all: "false",
      otel_service_name: `teable-perf-${artifactCase}-v1`,
    },
    {
      case_id: caseId,
      artifact_case: artifactCase,
      engine: "v2",
      force_v2_all: "true",
      otel_service_name: `teable-perf-${artifactCase}-v2`,
    },
  ];
});

process.stdout.write(JSON.stringify({ include }));
