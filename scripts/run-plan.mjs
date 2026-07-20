import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registeredCasePathsInOrder } from "./case-catalog.mjs";
import {
  buildFullRunCaseShards,
  resolveFullRunShardCount,
  validateFixtureAffinities,
} from "./full-run-shard-model.mjs";

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

const expandShardedPlan = ({
  name,
  engine,
  caseShards,
  computedUpdateMode,
  artifactSuffix,
  otelServiceSuffix,
}) => {
  return caseShards.flatMap((shardCaseIds, index) => {
    if (shardCaseIds.length === 0) {
      return [];
    }
    const shardNumber = index + 1;
    const shardLabel = `shard-${shardNumber}-of-${caseShards.length}`;
    return [
      {
        name: `${name}-${shardLabel}`,
        engine,
        caseFilter: shardCaseIds.join(","),
        excludeCaseFilter: "",
        computedUpdateMode,
        artifactSuffix: `${artifactSuffix}-${shardLabel}`,
        otelServiceSuffix: `${otelServiceSuffix}-${shardLabel}`,
        seedArtifactSuffix: shardLabel,
      },
    ];
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

export const buildFullRunShardCaseFilterKey = (shardLabel, caseIds) => {
  const caseSetHash = createHash("sha256")
    .update(caseIds.join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `all-${shardLabel}-${caseSetHash}`;
};

const resolveExecutePlan = ({
  engines,
  rawCaseFilter,
  caseFilterIsAll,
  requestedComputedUpdateMode,
  fullRunCaseShards,
}) =>
  engines.flatMap((engine) => {
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
          seedArtifactSuffix: "seed",
        },
      ];
    }

    if (engine !== "v2" || requestedComputedUpdateMode) {
      return expandShardedPlan({
        name: engine,
        engine,
        caseShards: fullRunCaseShards,
        computedUpdateMode: requestedComputedUpdateMode,
        artifactSuffix: engine,
        otelServiceSuffix: engine,
      });
    }

    const hybridCaseIdSet = new Set(HYBRID_COMPUTED_CASES);
    const syncCaseShards = fullRunCaseShards.map((caseIds) =>
      caseIds.filter((caseId) => !hybridCaseIdSet.has(caseId)),
    );
    const hybridCaseShards = fullRunCaseShards.map((caseIds) =>
      caseIds.filter((caseId) => hybridCaseIdSet.has(caseId)),
    );

    return [
      ...expandShardedPlan({
        name: "v2-sync-default",
        engine,
        caseShards: syncCaseShards,
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2-sync",
      }),
      ...expandShardedPlan({
        name: "v2-hybrid-computed",
        engine,
        caseShards: hybridCaseShards,
        computedUpdateMode: "hybrid",
        artifactSuffix: "v2-hybrid-computed",
        otelServiceSuffix: "v2-hybrid",
      }),
    ];
  });

const resolveSeedPlan = ({
  rawCaseFilter,
  caseFilterIsAll,
  fullRunCaseShards,
}) => {
  if (!caseFilterIsAll) {
    return [
      {
        name: "seed",
        caseFilter: rawCaseFilter,
        caseFilterKey: buildCaseFilterKey(rawCaseFilter),
        artifactSuffix: "seed",
      },
    ];
  }

  return fullRunCaseShards.map((caseIds, index) => {
    const shardLabel = `shard-${index + 1}-of-${fullRunCaseShards.length}`;
    return {
      name: shardLabel,
      caseFilter: caseIds.join(","),
      caseFilterKey: buildFullRunShardCaseFilterKey(shardLabel, caseIds),
      artifactSuffix: shardLabel,
    };
  });
};

export const resolveRunPlan = ({
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
  if (new Set(allCaseIds).size !== allCaseIds.length) {
    throw new Error("allCaseIds must not include duplicate case ids.");
  }

  const registeredCaseIds = new Set(allCaseIds);
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

  const affinityIssues = caseFilterIsAll
    ? validateFixtureAffinities({
        allCaseIds,
        hybridCaseIds: HYBRID_COMPUTED_CASES,
      })
    : [];
  if (affinityIssues.length > 0) {
    throw new Error(affinityIssues.join("\n"));
  }

  const fullRunCaseShards = caseFilterIsAll
    ? buildFullRunCaseShards({
        allCaseIds,
        hybridCaseIds: HYBRID_COMPUTED_CASES,
        shardCount: resolveFullRunShardCount(allCaseIds.length),
      })
    : [];

  return {
    engines,
    seedPlan: resolveSeedPlan({
      rawCaseFilter,
      caseFilterIsAll,
      fullRunCaseShards,
    }),
    executePlan: resolveExecutePlan({
      engines,
      rawCaseFilter,
      caseFilterIsAll,
      requestedComputedUpdateMode,
      fullRunCaseShards,
    }),
    caseFilterKey: buildCaseFilterKey(caseFilter),
  };
};

export const writeGithubOutputs = (
  { engines, seedPlan, executePlan, caseFilterKey },
  outputPath,
) => {
  appendFileSync(outputPath, `engines=${JSON.stringify(engines)}\n`);
  appendFileSync(outputPath, `seed_plan=${JSON.stringify(seedPlan)}\n`);
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
  console.log(`Resolved seed plan: ${JSON.stringify(plan.seedPlan)}`);
  console.log(`Resolved execute plan: ${JSON.stringify(plan.executePlan)}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
