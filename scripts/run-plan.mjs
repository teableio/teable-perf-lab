import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registeredCasePathsInOrder } from "./case-catalog.mjs";

export const FULL_RUN_SHARD_COUNT = 4;

export const HYBRID_COMPUTED_CASES = [
  "lookup/dual-link-computed-first-link-4k",
  "lookup/dual-link-computed-first-link-1of4k-get-record",
  "lookup/dual-link-computed-first-link-1of4k-get-records",
  "lookup/dual-link-computed-repoint-2k",
  "field-convert/formula-expression-update-4k-depth5-cascade",
  "field-convert/formula-dependency-add-4k-depth5-cascade",
  "field-convert/formula-dependency-replace-4k-depth5-cascade",
  "field-convert/formula-dependency-remove-4k-depth5-cascade",
  "lookup/foreign-select-flip-1of40-fanout100-4k",
  "lookup/foreign-first-name-update-1of40-fanout100-4k",
  "lookup/customer-update-user-create-order-4k-depth5",
  "lookup/customer-update-user-update-order-4k-depth5",
  "lookup/customer-create-user-create-order-4k-depth5",
  "lookup/customer-create-order-only-4k-depth5",
  "lookup/customer-update-user-first-name-only-create-order-4k-depth5",
  "lookup/customer-update-user-control-field-create-order-4k-depth5",
  "lookup/customer-update-other-user-create-order-4k-depth5",
];

const VALID_ENGINES = new Set(["v1", "v2"]);

const caseIdFromPath = (casePath) => {
  const match = /^cases\/(.+)\.case\.ts$/.exec(casePath);
  if (!match) {
    throw new Error(`Unsupported registered case path: ${casePath}`);
  }
  return match[1];
};

export const loadRegisteredCaseIds = async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const registry = await loadRegistry(repoRoot);
  return registeredCasePathsInOrder(registry).map(caseIdFromPath);
};

export const shardCaseIds = (caseIds, shardCount = FULL_RUN_SHARD_COUNT) => {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer.");
  }
  if (caseIds.length === 0) {
    throw new Error("Cannot shard an empty case list.");
  }

  const effectiveShardCount = Math.min(shardCount, caseIds.length);
  const shards = Array.from({ length: effectiveShardCount }, () => []);
  caseIds.forEach((caseId, index) => {
    shards[index % effectiveShardCount].push(caseId);
  });
  return shards;
};

const expandShardedPlan = ({
  name,
  engine,
  caseIds,
  computedUpdateMode,
  artifactSuffix,
  otelServiceSuffix,
}) => {
  const shards = shardCaseIds(caseIds);
  return shards.map((shardCaseIds, index) => {
    const shardNumber = index + 1;
    const shardLabel = `shard-${shardNumber}-of-${shards.length}`;
    return {
      name: `${name}-${shardLabel}`,
      engine,
      caseFilter: shardCaseIds.join(","),
      excludeCaseFilter: "",
      computedUpdateMode,
      artifactSuffix: `${artifactSuffix}-${shardLabel}`,
      otelServiceSuffix: `${otelServiceSuffix}-${shardLabel}`,
    };
  });
};

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
  allCaseIds = [],
}) => {
  const engines = parseEngineList(engineFilter);
  const caseFilters = parseCaseFiltersForCacheKey(caseFilter);
  const rawCaseFilter = caseFilter ?? "";
  const caseFilterIsAll = caseFilters.length === 1 && caseFilters[0] === "all";
  const requestedComputedUpdateMode = computedUpdateMode.trim();

  if (caseFilterIsAll && allCaseIds.length === 0) {
    throw new Error(
      "allCaseIds must include the registered cases for a full run.",
    );
  }

  const uniqueAllCaseIds = [...new Set(allCaseIds)];
  if (uniqueAllCaseIds.length !== allCaseIds.length) {
    throw new Error("allCaseIds must not include duplicate case ids.");
  }

  const registeredCaseIds = new Set(uniqueAllCaseIds);
  const missingHybridCaseIds = HYBRID_COMPUTED_CASES.filter(
    (caseId) => !registeredCaseIds.has(caseId),
  );
  if (
    caseFilterIsAll &&
    engines.includes("v2") &&
    !requestedComputedUpdateMode &&
    missingHybridCaseIds.length > 0
  ) {
    throw new Error(
      `Hybrid computed cases are not registered: ${missingHybridCaseIds.join(", ")}.`,
    );
  }

  return engines.flatMap((engine) => {
    if (!caseFilterIsAll) {
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

    if (engine !== "v2" || requestedComputedUpdateMode) {
      return expandShardedPlan({
        name: engine,
        engine,
        caseIds: uniqueAllCaseIds,
        computedUpdateMode: requestedComputedUpdateMode,
        artifactSuffix: engine,
        otelServiceSuffix: engine,
      });
    }

    const hybridCaseIds = uniqueAllCaseIds.filter((caseId) =>
      HYBRID_COMPUTED_CASES.includes(caseId),
    );
    const syncCaseIds = uniqueAllCaseIds.filter(
      (caseId) => !HYBRID_COMPUTED_CASES.includes(caseId),
    );

    return [
      ...expandShardedPlan({
        name: "v2-sync-default",
        engine,
        caseIds: syncCaseIds,
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2-sync",
      }),
      ...expandShardedPlan({
        name: "v2-hybrid-computed",
        engine,
        caseIds: hybridCaseIds,
        computedUpdateMode: "hybrid",
        artifactSuffix: "v2-hybrid-computed",
        otelServiceSuffix: "v2-hybrid",
      }),
    ];
  });
};

export const resolveRunPlan = ({
  engineFilter,
  caseFilter,
  computedUpdateMode = "",
  allCaseIds = [],
}) => {
  const engines = parseEngineList(engineFilter);
  return {
    engines,
    executePlan: resolveExecutePlan({
      engineFilter,
      caseFilter,
      computedUpdateMode,
      allCaseIds,
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

const main = async () => {
  const allCaseIds = await loadRegisteredCaseIds();
  const plan = resolveRunPlan({
    engineFilter: process.env.ENGINE_FILTER ?? "",
    caseFilter: process.env.CASE_FILTER ?? "",
    computedUpdateMode: process.env.COMPUTED_UPDATE_MODE ?? "",
    allCaseIds,
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
