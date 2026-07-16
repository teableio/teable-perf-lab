import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HYBRID_COMPUTED_CASES = [
  "computed-outbox/bullmq-pause-recovery-20k",
  "computed-outbox/formula-chain-update-1k-depth4",
  "computed-outbox/formula-chain-update-1k-depth8",
  "computed-outbox/formula-chain-update-20k-depth4-backlog",
  "computed-outbox/formula-chain-update-5001-depth2",
  "computed-outbox/formula-backfill-20k",
  "computed-outbox/observer-polling-ab-10k",
  "lookup/dual-link-computed-first-link-4k",
  "lookup/dual-link-computed-repoint-2k",
];

const VALID_ENGINES = new Set(["v1", "v2"]);

export const parseEngineList = (engineFilter = "") => {
  const engines = [
    ...new Set(
      engineFilter
        .split(",")
        .map((engine) => engine.trim())
        .filter(Boolean),
    ),
  ];
  const invalidEngines = engines.filter((engine) => !VALID_ENGINES.has(engine));

  if (engines.length === 0) {
    throw new Error("engine_filter must include at least one engine.");
  }

  if (invalidEngines.length > 0) {
    throw new Error(
      `Unsupported engine_filter value(s): ${invalidEngines.join(
        ", ",
      )}. Use v1, v2, or v1,v2.`,
    );
  }

  return engines;
};

export const parseCaseFiltersForCacheKey = (caseFilter = "") => {
  const trimmed = caseFilter.trim();
  const caseFilters =
    trimmed.toLowerCase() === "all"
      ? ["all"]
      : [
          ...new Set(
            trimmed
              .split(",")
              .map((caseId) => caseId.trim())
              .filter(Boolean)
              .sort(),
          ),
        ];

  if (caseFilters.length === 0) {
    throw new Error("case_filter must include at least one case id or all.");
  }

  return caseFilters;
};

export const buildCaseFilterKey = (caseFilter = "") =>
  parseCaseFiltersForCacheKey(caseFilter)
    .join("__")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

export const resolveExecutePlan = ({
  engineFilter,
  caseFilter,
  computedUpdateMode = "",
}) => {
  const engines = parseEngineList(engineFilter);
  const caseFilters = parseCaseFiltersForCacheKey(caseFilter);
  const rawCaseFilter = caseFilter ?? "";
  const caseFilterIsAll = caseFilters.length === 1 && caseFilters[0] === "all";
  const requestedComputedUpdateMode = computedUpdateMode.trim();

  return engines.flatMap((engine) => {
    if (engine !== "v2" || !caseFilterIsAll || requestedComputedUpdateMode) {
      return [
        {
          name: engine,
          engine,
          caseFilter: rawCaseFilter,
          excludeCaseFilter: "",
          computedUpdateMode: requestedComputedUpdateMode,
          artifactSuffix: engine,
          otelServiceSuffix: engine,
        },
      ];
    }

    return [
      {
        name: "v2-sync-default",
        engine,
        caseFilter: rawCaseFilter,
        excludeCaseFilter: HYBRID_COMPUTED_CASES.join(","),
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2-sync",
      },
      {
        name: "v2-hybrid-computed",
        engine,
        caseFilter: HYBRID_COMPUTED_CASES.join(","),
        excludeCaseFilter: "",
        computedUpdateMode: "hybrid",
        artifactSuffix: "v2-hybrid-computed",
        otelServiceSuffix: "v2-hybrid",
      },
    ];
  });
};

export const resolveRunPlan = ({
  engineFilter,
  caseFilter,
  computedUpdateMode = "",
}) => {
  const engines = parseEngineList(engineFilter);
  return {
    engines,
    executePlan: resolveExecutePlan({
      engineFilter,
      caseFilter,
      computedUpdateMode,
    }),
    caseFilterKey: buildCaseFilterKey(caseFilter),
  };
};

export const writeGithubOutputs = (
  { engines, executePlan, caseFilterKey },
  outputPath,
) => {
  appendFileSync(outputPath, `engines=${JSON.stringify(engines)}\n`);
  appendFileSync(outputPath, `execute_plan=${JSON.stringify(executePlan)}\n`);
  appendFileSync(outputPath, `case_filter_key=${caseFilterKey}\n`);
};

const main = () => {
  const plan = resolveRunPlan({
    engineFilter: process.env.ENGINE_FILTER ?? "",
    caseFilter: process.env.CASE_FILTER ?? "",
    computedUpdateMode: process.env.COMPUTED_UPDATE_MODE ?? "",
  });

  if (process.env.GITHUB_OUTPUT) {
    writeGithubOutputs(plan, process.env.GITHUB_OUTPUT);
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }

  console.log(`Resolved engines: ${plan.engines.join(", ")}`);
  console.log(`Resolved case filter cache key: ${plan.caseFilterKey}`);
  console.log(`Resolved execute plan: ${JSON.stringify(plan.executePlan)}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
