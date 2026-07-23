import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registeredCasePathsInOrder } from "./case-catalog.mjs";
import {
  buildFullRunCaseShardPlan,
  resolveFixtureAffinities,
  resolveFullRunCaseIds,
  resolveFullRunShardCount,
  validateFixtureAffinities,
  validateShardAffinityAssignments,
} from "./full-run-shard-model.mjs";
import { FULL_RUN_HISTORICAL_BUNDLE_SLOTS } from "./full-run-historical-bundle-slots.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import {
  buildCaseSetDigest,
  normalizeSeedCacheNamespace,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";
import {
  renderStagePlanSummaryMarkdown,
  simulateStageAwareShardPlans,
} from "./stage-aware-shard-model.mjs";

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
  "lookup/foreign-select-flip-1of40-fanout500-20k",
  "lookup/foreign-first-name-update-1of40-fanout500-20k",
  "record-update/single-foreign-select-update-1of40-fanout100-4k",
  "record-update/single-foreign-first-name-update-1of40-fanout100-4k",
  "record-update/single-foreign-select-update-1of40-fanout500-20k",
  "record-update/single-foreign-first-name-update-1of40-fanout500-20k",
  "lookup/customer-update-user-create-order-4k-depth5",
  "lookup/customer-update-user-update-order-4k-depth5",
  "lookup/customer-create-user-create-order-4k-depth5",
  "lookup/customer-create-order-only-4k-depth5",
  "lookup/customer-create-order-only-20k-depth5",
  "lookup/customer-update-user-first-name-only-create-order-4k-depth5",
  "lookup/customer-update-user-control-field-create-order-4k-depth5",
  "lookup/customer-update-user-control-field-create-order-20k-depth5",
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

export const parseCaseSeedAffinity = (caseSource) => {
  const declarations = [...caseSource.matchAll(/^\s*seedAffinity\s*:/gm)];
  const matches = [
    ...caseSource.matchAll(/^\s*seedAffinity:\s*["']([^"']+)["'],?\s*$/gm),
  ];
  if (declarations.length > 1) {
    throw new Error("seedAffinity must be declared at most once per case.");
  }
  if (declarations.length === 1 && matches.length !== 1) {
    throw new Error("seedAffinity must be a non-empty string literal.");
  }
  const seedAffinity = matches[0]?.[1];
  if (seedAffinity != null && seedAffinity.trim().length === 0) {
    throw new Error("seedAffinity must be a non-empty string literal.");
  }
  return seedAffinity;
};

export const parseCaseAcceptanceContract = (caseSource) => {
  const routingDeclarations = [
    ...caseSource.matchAll(/^\s*routingEvidence\s*:/gm),
  ];
  const routingMatches = [
    ...caseSource.matchAll(
      /^\s*routingEvidence:\s*["']not-applicable["'],?\s*$/gm,
    ),
  ];
  if (
    routingDeclarations.length > 1 ||
    routingDeclarations.length !== routingMatches.length
  ) {
    throw new Error(
      'routingEvidence must be declared at most once as "not-applicable".',
    );
  }
  const skipDeclarations = [
    ...caseSource.matchAll(/^\s*expectedSkipEngines\s*:/gm),
  ];
  const skipMatches = [
    ...caseSource.matchAll(
      /^\s*expectedSkipEngines:\s*\[((?:\s*["'](?:v1|v2)["']\s*,?)*)\],?\s*$/gm,
    ),
  ];
  if (
    skipDeclarations.length > 1 ||
    skipDeclarations.length !== skipMatches.length
  ) {
    throw new Error(
      "expectedSkipEngines must be declared at most once as a literal v1/v2 array.",
    );
  }
  const expectedSkipEngines = skipMatches[0]
    ? [
        ...new Set(
          [...skipMatches[0][1].matchAll(/["'](v1|v2)["']/g)].map(
            (match) => match[1],
          ),
        ),
      ]
    : [];
  if (skipMatches[0] && expectedSkipEngines.length === 0) {
    throw new Error("expectedSkipEngines must not be empty.");
  }
  return {
    ...(routingMatches.length === 1
      ? { routingEvidence: "not-applicable" }
      : {}),
    ...(expectedSkipEngines.length > 0 ? { expectedSkipEngines } : {}),
  };
};

export const loadRegisteredCases = async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const registry = await loadRegistry(repoRoot);
  return Promise.all(
    registeredCasePathsInOrder(registry).map(async (casePath) => {
      const caseSource = await readFile(join(repoRoot, casePath), "utf8");
      const seedAffinity = parseCaseSeedAffinity(caseSource);
      return {
        id: caseIdFromPath(casePath),
        ...(seedAffinity ? { seedAffinity } : {}),
        ...parseCaseAcceptanceContract(caseSource),
      };
    }),
  );
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
  const caseSetHash = buildCaseSetDigest(caseIds);
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
  selectedCaseIds,
  caseFilterIsAll,
  fullRunCaseShards,
}) => {
  if (!caseFilterIsAll) {
    return [
      {
        name: "seed",
        caseFilter: rawCaseFilter,
        caseFilterKey: buildCaseFilterKey(rawCaseFilter),
        caseSetDigest: buildCaseSetDigest(selectedCaseIds),
        stableSlot: "targeted",
        seedContractGeneration: SEED_CONTRACT_GENERATION,
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
      caseSetDigest: buildCaseSetDigest(caseIds),
      stableSlot: `slot-${index + 1}`,
      seedContractGeneration: SEED_CONTRACT_GENERATION,
      artifactSuffix: shardLabel,
    };
  });
};

const compactStageCandidate = (candidate) => ({
  shardCount: candidate.shardCount,
  stageMaxima: candidate.stageMaxima,
  criticalPath: candidate.criticalPath,
  concurrencyCost: candidate.concurrencyCost,
  estimatedCacheImpactMs: candidate.estimatedCacheImpactMs,
  bundleCount: candidate.bundleCount,
  caseCount: candidate.caseCount,
});

const compactStageSimulation = (simulation, executionProfile) => ({
  ...simulation.summary,
  executionProfile,
  calibrationSource: {
    sourceRunId: FULL_RUN_STAGE_CALIBRATION.sourceRunId,
    sourceUrl: FULL_RUN_STAGE_CALIBRATION.sourceUrl,
    sourcePerfLabSha: FULL_RUN_STAGE_CALIBRATION.sourcePerfLabSha,
    sourceTeableEeSha: FULL_RUN_STAGE_CALIBRATION.sourceTeableEeSha,
    sourceArtifactRunId: FULL_RUN_STAGE_CALIBRATION.sourceArtifactRunId,
    pairedWarmRunId: FULL_RUN_STAGE_CALIBRATION.pairedWarmRunId,
    pairedWarmRunUrl: FULL_RUN_STAGE_CALIBRATION.pairedWarmRunUrl,
  },
  baselineCriticalPath: simulation.baselineCriticalPath,
  candidates: simulation.candidates.map(compactStageCandidate),
});

export const resolveRunPlan = ({
  engineFilter,
  caseFilter,
  computedUpdateMode = "",
  seedCacheNamespace = "",
  allCaseIds = [],
  seedAffinityDeclarations = [],
}) => {
  const engines = parseEngineList(engineFilter);
  const caseFilters = parseCaseFiltersForCacheKey(caseFilter);
  const rawCaseFilter = caseFilter ?? "";
  const caseFilterIsAll = caseFilters.length === 1 && caseFilters[0] === "all";
  const requestedComputedUpdateMode = computedUpdateMode.trim();
  const normalizedSeedCacheNamespace =
    normalizeSeedCacheNamespace(seedCacheNamespace);
  if (
    requestedComputedUpdateMode &&
    !["sync", "hybrid"].includes(requestedComputedUpdateMode)
  ) {
    throw new Error("computed_update_mode must be empty, sync, or hybrid.");
  }

  if (caseFilterIsAll && allCaseIds.length === 0) {
    throw new Error(
      "allCaseIds must include the registered cases for a full run.",
    );
  }
  if (new Set(allCaseIds).size !== allCaseIds.length) {
    throw new Error("allCaseIds must not include duplicate case ids.");
  }

  const registeredCaseIds = new Set(allCaseIds);
  const fullRunCaseIds = caseFilterIsAll
    ? resolveFullRunCaseIds({ allCaseIds })
    : [];
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

  const fixtureAffinities = caseFilterIsAll
    ? resolveFixtureAffinities({ seedAffinityDeclarations })
    : [];
  const affinityIssues = caseFilterIsAll
    ? validateFixtureAffinities({
        allCaseIds,
        hybridCaseIds: HYBRID_COMPUTED_CASES,
        affinities: fixtureAffinities,
      })
    : [];
  if (affinityIssues.length > 0) {
    throw new Error(affinityIssues.join("\n"));
  }

  const scalarBaselineShardPlan = caseFilterIsAll
    ? buildFullRunCaseShardPlan({
        allCaseIds: fullRunCaseIds,
        hybridCaseIds: HYBRID_COMPUTED_CASES,
        shardCount: resolveFullRunShardCount(fullRunCaseIds.length),
        affinities: fixtureAffinities,
      })
    : {
        caseShards: [],
        shardLoads: [],
        movedAffinities: [],
        preservedAffinityCount: 0,
      };
  const v2Mode = !engines.includes("v2")
    ? "none"
    : requestedComputedUpdateMode || "split";
  const stageHybridCaseIds =
    v2Mode === "split"
      ? HYBRID_COMPUTED_CASES
      : v2Mode === "hybrid"
        ? fullRunCaseIds
        : [];
  const activeExecuteStages = [
    ...(engines.includes("v1") ? ["v1Ms"] : []),
    ...(v2Mode === "split" || v2Mode === "sync" ? ["v2SyncMs"] : []),
    ...(v2Mode === "split" || v2Mode === "hybrid" ? ["v2HybridMs"] : []),
  ];
  const executionProfile = { engines: engines.slice(), v2Mode };
  const stageSimulation = caseFilterIsAll
    ? simulateStageAwareShardPlans({
        caseIds: fullRunCaseIds,
        hybridCaseIds: stageHybridCaseIds,
        affinities: fixtureAffinities,
        caseCosts: FULL_RUN_STAGE_CALIBRATION.caseCosts,
        preferredSlotByBundle: FULL_RUN_HISTORICAL_BUNDLE_SLOTS,
        activeExecuteStages,
        fixedCosts: FULL_RUN_STAGE_CALIBRATION.fixedCosts,
        baselineCaseShards: scalarBaselineShardPlan.caseShards,
      })
    : null;
  const fullRunShardPlan = stageSimulation?.selected ?? scalarBaselineShardPlan;
  const movedBundles = stageSimulation
    ? fullRunShardPlan.movedBundles
    : fullRunShardPlan.movedAffinities.map(({ affinityId, ...movement }) => ({
        bundleId: affinityId,
        ...movement,
      }));
  const preservedBundleCount = stageSimulation
    ? fullRunShardPlan.preservedBundleCount
    : fullRunShardPlan.preservedAffinityCount;
  const fullRunCaseShards = fullRunShardPlan.caseShards;
  const assignmentIssues = caseFilterIsAll
    ? validateShardAffinityAssignments({
        caseShards: fullRunCaseShards,
        affinities: fixtureAffinities,
      })
    : [];
  if (assignmentIssues.length > 0) {
    throw new Error(assignmentIssues.join("\n"));
  }

  return {
    engines,
    caseFilterIsAll,
    seedPlan: resolveSeedPlan({
      rawCaseFilter,
      selectedCaseIds: caseFilters,
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
    seedCacheNamespace: normalizedSeedCacheNamespace,
    planSummary: {
      shardCount: caseFilterIsAll ? fullRunCaseShards.length : 1,
      stableSlotCount: caseFilterIsAll ? fullRunCaseShards.length : 1,
      preservedBundleCount,
      movedBundles,
      estimatedCacheImpactMs: movedBundles.reduce(
        (total, movement) => total + movement.estimatedCacheImpactMs,
        0,
      ),
      ...(normalizedSeedCacheNamespace
        ? { seedCacheNamespace: normalizedSeedCacheNamespace }
        : {}),
      ...(stageSimulation
        ? {
            stagePlan: compactStageSimulation(
              stageSimulation,
              executionProfile,
            ),
          }
        : {}),
    },
  };
};

export const writeGithubOutputs = (
  {
    engines,
    seedPlan,
    executePlan,
    caseFilterIsAll,
    caseFilterKey,
    seedCacheNamespace,
    planSummary,
  },
  outputPath,
) => {
  appendFileSync(outputPath, `engines=${JSON.stringify(engines)}\n`);
  appendFileSync(outputPath, `seed_plan=${JSON.stringify(seedPlan)}\n`);
  appendFileSync(outputPath, `execute_plan=${JSON.stringify(executePlan)}\n`);
  appendFileSync(outputPath, `case_filter_is_all=${caseFilterIsAll}\n`);
  appendFileSync(outputPath, `case_filter_key=${caseFilterKey}\n`);
  appendFileSync(outputPath, `seed_cache_namespace=${seedCacheNamespace}\n`);
  appendFileSync(
    outputPath,
    `seed_cache_namespace_segment=${
      seedCacheNamespace ? `${seedCacheNamespace}-` : ""
    }\n`,
  );
  appendFileSync(outputPath, `plan_summary=${JSON.stringify(planSummary)}\n`);
};

export const renderPlanSummaryMarkdown = (summary) => {
  const lines = [
    "## Full-run plan",
    "",
    `- Shards: ${summary.shardCount}`,
    `- Stable slots: ${summary.stableSlotCount}`,
    `- Preserved bundles: ${summary.preservedBundleCount}`,
    `- Estimated cache impact: ${summary.estimatedCacheImpactMs} ms cold seed`,
  ];
  if (summary.seedCacheNamespace) {
    lines.push(`- Seed cache namespace: ${summary.seedCacheNamespace}`);
  }
  if (summary.movedBundles.length === 0) {
    lines.push("- Bundle moves: none");
  } else {
    lines.push("- Bundle moves:");
    for (const movement of summary.movedBundles) {
      lines.push(
        `  - ${movement.bundleId}: slot-${movement.fromStableSlot} -> slot-${movement.toStableSlot}; ${movement.estimatedCacheImpactMs} ms cache impact; cases ${movement.caseIds.join(", ")}`,
      );
    }
  }
  if (summary.stagePlan) {
    const selected = summary.stagePlan.candidates.find(
      ({ shardCount }) => shardCount === summary.stagePlan.selectedShardCount,
    );
    lines.push(
      "",
      renderStagePlanSummaryMarkdown({
        selected,
        candidates: summary.stagePlan.candidates,
        summary: summary.stagePlan,
      }).trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const registeredCases = await loadRegisteredCases();
  const allCaseIds = registeredCases.map(({ id }) => id);
  const plan = resolveRunPlan({
    engineFilter: process.env.ENGINE_FILTER ?? "",
    caseFilter: process.env.CASE_FILTER ?? "",
    computedUpdateMode: process.env.COMPUTED_UPDATE_MODE ?? "",
    seedCacheNamespace: process.env.SEED_CACHE_NAMESPACE ?? "",
    allCaseIds,
    seedAffinityDeclarations: registeredCases
      .filter(({ seedAffinity }) => seedAffinity != null)
      .map(({ id, seedAffinity }) => ({
        caseId: id,
        affinityId: seedAffinity,
      })),
  });

  if (process.env.GITHUB_OUTPUT) {
    writeGithubOutputs(plan, process.env.GITHUB_OUTPUT);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderPlanSummaryMarkdown(plan.planSummary),
      );
    }
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }

  console.log(`Resolved engines: ${plan.engines.join(", ")}`);
  console.log(`Resolved case filter cache key: ${plan.caseFilterKey}`);
  console.log(`Resolved seed plan: ${JSON.stringify(plan.seedPlan)}`);
  console.log(`Resolved execute plan: ${JSON.stringify(plan.executePlan)}`);
  console.log(`Resolved plan summary: ${JSON.stringify(plan.planSummary)}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
