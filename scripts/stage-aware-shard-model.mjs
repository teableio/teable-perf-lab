import { fullRunCaseSeedWeightMs } from "./full-run-shard-model.mjs";

export const STAGE_COST_KEYS = [
  "coldSeedMs",
  "v1Ms",
  "v2SyncMs",
  "v2HybridMs",
  "traceMs",
];

export const DEFAULT_STAGE_CASE_COSTS = {
  v1Ms: 10_000,
  v2Ms: 10_000,
  traceMs: 1_000,
};

export const DEFAULT_STAGE_PLAN_FIXED_COSTS = {
  coldSeedSetupMs: 120_000,
  warmSeedMs: 30_000,
  executeSetupMs: 120_000,
  reportMs: 30_000,
  traceJobBudgetMs: 60_000,
};

const EXECUTE_STAGE_KEYS = ["v1Ms", "v2SyncMs", "v2HybridMs"];

const normalizeActiveExecuteStages = (stages = EXECUTE_STAGE_KEYS) => {
  if (!Array.isArray(stages)) {
    throw new Error("activeExecuteStages must be an array.");
  }
  const unique = [...new Set(stages)];
  const invalid = unique.filter((stage) => !EXECUTE_STAGE_KEYS.includes(stage));
  if (invalid.length > 0) {
    throw new Error(
      `Unsupported active execute stage(s): ${invalid.join(", ")}.`,
    );
  }
  return EXECUTE_STAGE_KEYS.filter((stage) => unique.includes(stage));
};

const emptyStageCosts = () =>
  Object.fromEntries(STAGE_COST_KEYS.map((stage) => [stage, 0]));

const assertNonNegativeFinite = (value, label) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
};

const assertPositiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const compareNumbers = (left, right) => {
  const difference = left - right;
  return Math.abs(difference) < 1e-9 ? 0 : difference;
};

const compareNumberVectors = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = compareNumbers(left[index] ?? 0, right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const affinityMembership = ({ caseIds, hybridCaseIds, affinities }) => {
  const selected = new Set(caseIds);
  const hybrid = new Set(hybridCaseIds);
  const membership = new Map();

  for (const affinity of affinities) {
    if (typeof affinity.id !== "string" || affinity.id.trim().length === 0) {
      throw new Error("Fixture affinity id must be a non-empty string.");
    }
    const selectedCaseIds = affinity.caseIds.filter((caseId) =>
      selected.has(caseId),
    );
    const modes = new Set(
      selectedCaseIds.map((caseId) => (hybrid.has(caseId) ? "hybrid" : "sync")),
    );
    if (modes.size > 1) {
      throw new Error(
        `Fixture affinity ${affinity.id} crosses V2 sync and hybrid pools`,
      );
    }
    for (const caseId of selectedCaseIds) {
      const previous = membership.get(caseId);
      if (previous) {
        throw new Error(
          `Case ${caseId} belongs to multiple fixture affinities: ${previous}, ${affinity.id}`,
        );
      }
      membership.set(caseId, affinity.id);
    }
  }
  return membership;
};

const resolveCaseStageCosts = ({
  caseId,
  hybrid,
  caseCosts,
  defaultCaseCosts,
  activeExecuteStages,
}) => {
  const calibrated = caseCosts[caseId] ?? {};
  const coldSeedMs = calibrated.coldSeedMs ?? fullRunCaseSeedWeightMs(caseId);
  const v1Ms = calibrated.v1Ms ?? defaultCaseCosts.v1Ms;
  const v2Ms = hybrid
    ? (calibrated.v2HybridMs ??
      calibrated.v2SyncMs ??
      calibrated.v2Ms ??
      defaultCaseCosts.v2Ms)
    : (calibrated.v2SyncMs ?? calibrated.v2Ms ?? defaultCaseCosts.v2Ms);
  const traceMs = calibrated.traceMs ?? defaultCaseCosts.traceMs;
  const result = {
    coldSeedMs,
    v1Ms,
    v2SyncMs: hybrid ? 0 : v2Ms,
    v2HybridMs: hybrid ? v2Ms : 0,
    traceMs,
  };
  const active = new Set(activeExecuteStages);
  for (const stage of EXECUTE_STAGE_KEYS) {
    if (!active.has(stage)) {
      result[stage] = 0;
    }
  }
  for (const stage of STAGE_COST_KEYS) {
    assertNonNegativeFinite(result[stage], `${caseId}.${stage}`);
  }
  return result;
};

export const buildAffinityStageBundles = ({
  caseIds,
  hybridCaseIds = [],
  affinities = [],
  caseCosts = {},
  defaultCaseCosts = DEFAULT_STAGE_CASE_COSTS,
  activeExecuteStages = EXECUTE_STAGE_KEYS,
}) => {
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("caseIds must not include duplicate case ids.");
  }
  const membership = affinityMembership({
    caseIds,
    hybridCaseIds,
    affinities,
  });
  const hybrid = new Set(hybridCaseIds);
  const normalizedActiveExecuteStages =
    normalizeActiveExecuteStages(activeExecuteStages);
  const bundles = new Map();

  caseIds.forEach((caseId, firstIndex) => {
    const id = membership.get(caseId) ?? `case:${caseId}`;
    const bundle = bundles.get(id) ?? {
      id,
      caseIds: [],
      firstIndex,
      stageCosts: emptyStageCosts(),
      cacheImpactMs: 0,
    };
    const costs = resolveCaseStageCosts({
      caseId,
      hybrid: hybrid.has(caseId),
      caseCosts,
      defaultCaseCosts,
      activeExecuteStages: normalizedActiveExecuteStages,
    });
    bundle.caseIds.push(caseId);
    // A physical fixture is built once per affinity bundle. All measured case
    // executions and trace evidence still run independently.
    bundle.stageCosts.coldSeedMs = Math.max(
      bundle.stageCosts.coldSeedMs,
      costs.coldSeedMs,
    );
    for (const stage of STAGE_COST_KEYS.slice(1)) {
      bundle.stageCosts[stage] += costs[stage];
    }
    bundle.cacheImpactMs = bundle.stageCosts.coldSeedMs;
    bundles.set(id, bundle);
  });

  return [...bundles.values()];
};

const addBundleCosts = ({ current, bundle, traceJobBudgetMs }) => {
  const result = { ...current };
  for (const stage of STAGE_COST_KEYS) {
    result[stage] += bundle.stageCosts[stage];
  }
  result.traceMs = Math.min(result.traceMs, traceJobBudgetMs);
  return result;
};

const resolveStageMaxima = ({ shardStageCosts, shardBundles }) =>
  Object.fromEntries(
    STAGE_COST_KEYS.map((stage) => {
      let shardIndex = 0;
      for (let index = 1; index < shardStageCosts.length; index += 1) {
        if (
          shardStageCosts[index][stage] > shardStageCosts[shardIndex][stage]
        ) {
          shardIndex = index;
        }
      }
      const criticalBundle = shardBundles[shardIndex]
        .slice()
        .sort(
          (left, right) =>
            right.stageCosts[stage] - left.stageCosts[stage] ||
            left.id.localeCompare(right.id),
        )[0];
      return [
        stage,
        {
          durationMs: shardStageCosts[shardIndex][stage],
          shard: `shard-${shardIndex + 1}-of-${shardStageCosts.length}`,
          bundleId: criticalBundle?.id ?? null,
        },
      ];
    }),
  );

const placementScore = ({ shardStageCosts, stageTotals }) => {
  const maxima = STAGE_COST_KEYS.map((stage) =>
    Math.max(...shardStageCosts.map((costs) => costs[stage]), 0),
  );
  const coldSeedMax = maxima[STAGE_COST_KEYS.indexOf("coldSeedMs")];
  const executeMax = Math.max(
    maxima[STAGE_COST_KEYS.indexOf("v1Ms")],
    maxima[STAGE_COST_KEYS.indexOf("v2SyncMs")],
    maxima[STAGE_COST_KEYS.indexOf("v2HybridMs")],
  );
  const traceMax = maxima[STAGE_COST_KEYS.indexOf("traceMs")];
  const normalizedMaxima = maxima.map((maximum, index) => {
    const stage = STAGE_COST_KEYS[index];
    const average = stageTotals[stage] / shardStageCosts.length;
    return average === 0 ? 0 : maximum / average;
  });
  const squaredLoad = shardStageCosts.reduce(
    (total, costs) =>
      total +
      STAGE_COST_KEYS.reduce((stageTotal, stage) => {
        const average = stageTotals[stage] / shardStageCosts.length;
        const ratio = average === 0 ? 0 : costs[stage] / average;
        return stageTotal + ratio * ratio;
      }, 0),
    0,
  );
  return [
    coldSeedMax + executeMax + traceMax,
    Math.max(...normalizedMaxima),
    squaredLoad,
    ...maxima,
  ];
};

export const planStageAwareShards = ({
  caseIds,
  hybridCaseIds = [],
  shardCount,
  affinities = [],
  caseCosts = {},
  defaultCaseCosts = DEFAULT_STAGE_CASE_COSTS,
  preferredSlotByBundle = {},
  activeExecuteStages = EXECUTE_STAGE_KEYS,
  stabilityToleranceRatio = 1.03,
  traceJobBudgetMs = DEFAULT_STAGE_PLAN_FIXED_COSTS.traceJobBudgetMs,
}) => {
  assertPositiveInteger(shardCount, "shardCount");
  assertNonNegativeFinite(traceJobBudgetMs, "traceJobBudgetMs");
  if (
    !Number.isFinite(stabilityToleranceRatio) ||
    stabilityToleranceRatio < 1
  ) {
    throw new Error("stabilityToleranceRatio must be at least 1.");
  }
  if (caseIds.length === 0) {
    throw new Error("Cannot shard an empty case list.");
  }

  const bundles = buildAffinityStageBundles({
    caseIds,
    hybridCaseIds,
    affinities,
    caseCosts,
    defaultCaseCosts,
    activeExecuteStages,
  });
  const stageTotals = emptyStageCosts();
  for (const bundle of bundles) {
    for (const stage of STAGE_COST_KEYS) {
      stageTotals[stage] += bundle.stageCosts[stage];
    }
  }
  const dominantShare = (bundle) =>
    Math.max(
      ...STAGE_COST_KEYS.map((stage) =>
        stageTotals[stage] === 0
          ? 0
          : bundle.stageCosts[stage] / stageTotals[stage],
      ),
    );
  const orderedBundles = bundles
    .slice()
    .sort(
      (left, right) =>
        dominantShare(right) - dominantShare(left) ||
        Math.max(...Object.values(right.stageCosts)) -
          Math.max(...Object.values(left.stageCosts)) ||
        right.caseIds.length - left.caseIds.length ||
        left.firstIndex - right.firstIndex ||
        left.id.localeCompare(right.id),
    );
  const shardBundles = Array.from({ length: shardCount }, () => []);
  const shardStageCosts = Array.from({ length: shardCount }, emptyStageCosts);

  for (const bundle of orderedBundles) {
    const placements = shardStageCosts.map((_, target) => {
      const projected = shardStageCosts.map((costs, index) =>
        index === target
          ? addBundleCosts({ current: costs, bundle, traceJobBudgetMs })
          : costs,
      );
      return {
        target,
        projected,
        score: placementScore({
          shardStageCosts: projected,
          stageTotals,
        }),
      };
    });
    placements.sort(
      (left, right) =>
        compareNumberVectors(left.score, right.score) ||
        left.target - right.target,
    );
    let selected = placements[0];
    const preferredSlot = preferredSlotByBundle[bundle.id];
    if (
      Number.isInteger(preferredSlot) &&
      preferredSlot >= 1 &&
      preferredSlot <= shardCount
    ) {
      const preferred = placements.find(
        ({ target }) => target === preferredSlot - 1,
      );
      const withinCriticalTolerance =
        preferred.score[0] <= selected.score[0] * stabilityToleranceRatio;
      const withinBalanceTolerance =
        preferred.score[1] <= selected.score[1] * stabilityToleranceRatio;
      if (withinCriticalTolerance && withinBalanceTolerance) {
        selected = preferred;
      }
    }
    shardBundles[selected.target].push(bundle);
    shardStageCosts[selected.target] = selected.projected[selected.target];
  }

  const caseOrder = new Map(caseIds.map((caseId, index) => [caseId, index]));
  const caseShards = shardBundles.map((items) =>
    items
      .flatMap(({ caseIds: bundleCaseIds }) => bundleCaseIds)
      .sort((left, right) => caseOrder.get(left) - caseOrder.get(right)),
  );
  const movedBundles = bundles.flatMap((bundle) => {
    const fromStableSlot = preferredSlotByBundle[bundle.id];
    if (fromStableSlot == null) {
      return [];
    }
    if (!Number.isInteger(fromStableSlot) || fromStableSlot < 1) {
      throw new Error(
        `Preferred stable slot for ${bundle.id} must be a positive integer.`,
      );
    }
    const toStableSlot =
      shardBundles.findIndex((items) => items.includes(bundle)) + 1;
    if (toStableSlot === fromStableSlot) {
      return [];
    }
    return [
      {
        bundleId: bundle.id,
        fromStableSlot,
        toStableSlot,
        caseIds: bundle.caseIds.slice(),
        estimatedCacheImpactMs: bundle.cacheImpactMs,
        reason:
          fromStableSlot > shardCount
            ? "stable slot is unavailable at this shard count"
            : "stage load takes priority over stable placement",
      },
    ];
  });

  return {
    shardCount,
    caseShards,
    shardStageCosts,
    shardBundleIds: shardBundles.map((items) => items.map(({ id }) => id)),
    stageMaxima: resolveStageMaxima({ shardStageCosts, shardBundles }),
    movedBundles: movedBundles.sort((left, right) =>
      left.bundleId.localeCompare(right.bundleId),
    ),
    preservedBundleCount:
      bundles.filter(({ id }) => preferredSlotByBundle[id] != null).length -
      movedBundles.length,
    estimatedCacheImpactMs: movedBundles.reduce(
      (total, movement) => total + movement.estimatedCacheImpactMs,
      0,
    ),
    bundleCount: bundles.length,
    caseCount: caseIds.length,
  };
};

const nonEmptyStage = (plan, stage) =>
  plan.shardStageCosts.some((costs) => costs[stage] > 0);

const attachCandidateMetrics = ({ plan, fixedCosts, coldSloMs, warmSloMs }) => {
  const predictedStages = {
    coldSeedMs:
      plan.stageMaxima.coldSeedMs.durationMs + fixedCosts.coldSeedSetupMs,
    v1Ms:
      plan.stageMaxima.v1Ms.durationMs +
      (nonEmptyStage(plan, "v1Ms") ? fixedCosts.executeSetupMs : 0),
    v2SyncMs:
      plan.stageMaxima.v2SyncMs.durationMs +
      (nonEmptyStage(plan, "v2SyncMs") ? fixedCosts.executeSetupMs : 0),
    v2HybridMs:
      plan.stageMaxima.v2HybridMs.durationMs +
      (nonEmptyStage(plan, "v2HybridMs") ? fixedCosts.executeSetupMs : 0),
    traceMs: plan.stageMaxima.traceMs.durationMs,
  };
  const executeCriticalMs =
    Math.max(
      predictedStages.v1Ms,
      predictedStages.v2SyncMs,
      predictedStages.v2HybridMs,
    ) + predictedStages.traceMs;
  const coldWallMs =
    predictedStages.coldSeedMs + executeCriticalMs + fixedCosts.reportMs;
  const warmWallMs =
    fixedCosts.warmSeedMs + executeCriticalMs + fixedCosts.reportMs;
  const v1Jobs = plan.shardStageCosts.filter(
    (costs) => costs.v1Ms > 0,
  ).length;
  const v2SyncJobs = plan.shardStageCosts.filter(
    (costs) => costs.v2SyncMs > 0,
  ).length;
  const v2HybridJobs = plan.shardStageCosts.filter(
    (costs) => costs.v2HybridMs > 0,
  ).length;
  return {
    ...plan,
    predictedStages,
    criticalPath: {
      executeMs: executeCriticalMs,
      coldWallMs,
      warmWallMs,
      meetsColdSlo: coldWallMs <= coldSloMs,
      meetsWarmSlo: warmWallMs <= warmSloMs,
    },
    concurrencyCost: {
      seedJobs: plan.shardCount,
      v1Jobs,
      v2SyncJobs,
      v2HybridJobs,
      executeJobs: v1Jobs + v2SyncJobs + v2HybridJobs,
      peakJobs: Math.max(
        plan.shardCount,
        v1Jobs + v2SyncJobs + v2HybridJobs,
        1,
      ),
      totalJobs: plan.shardCount + v1Jobs + v2SyncJobs + v2HybridJobs + 2,
    },
  };
};

const summarizeObserved = (observedStages) =>
  observedStages == null
    ? null
    : {
        sourceRunId: observedStages.sourceRunId,
        ...Object.fromEntries(
          STAGE_COST_KEYS.map((stage) => [stage, observedStages[stage] ?? 0]),
        ),
      };

export const simulateStageAwareShardPlans = ({
  caseIds,
  hybridCaseIds = [],
  affinities = [],
  caseCosts = {},
  defaultCaseCosts = DEFAULT_STAGE_CASE_COSTS,
  preferredSlotByBundle = {},
  activeExecuteStages = EXECUTE_STAGE_KEYS,
  shardCounts = [6, 7, 8, 9, 10, 11, 12],
  coldSloMs = 45 * 60_000,
  warmSloMs = 25 * 60_000,
  fixedCosts = DEFAULT_STAGE_PLAN_FIXED_COSTS,
  observedStages,
  baselineCaseShards,
}) => {
  if (shardCounts.length === 0) {
    throw new Error("shardCounts must include at least one candidate.");
  }
  const sortedShardCounts = [...new Set(shardCounts)].sort(
    (left, right) => left - right,
  );
  sortedShardCounts.forEach((count) =>
    assertPositiveInteger(count, "candidate shard count"),
  );
  assertNonNegativeFinite(coldSloMs, "coldSloMs");
  assertNonNegativeFinite(warmSloMs, "warmSloMs");
  const resolvedFixedCosts = {
    ...DEFAULT_STAGE_PLAN_FIXED_COSTS,
    ...fixedCosts,
  };
  const normalizedActiveExecuteStages =
    normalizeActiveExecuteStages(activeExecuteStages);
  Object.entries(resolvedFixedCosts).forEach(([key, value]) =>
    assertNonNegativeFinite(value, `fixedCosts.${key}`),
  );
  const candidates = sortedShardCounts.map((shardCount) =>
    attachCandidateMetrics({
      plan: planStageAwareShards({
        caseIds,
        hybridCaseIds,
        shardCount,
        affinities,
        caseCosts,
        defaultCaseCosts,
        preferredSlotByBundle,
        activeExecuteStages: normalizedActiveExecuteStages,
        traceJobBudgetMs: resolvedFixedCosts.traceJobBudgetMs,
      }),
      fixedCosts: resolvedFixedCosts,
      coldSloMs,
      warmSloMs,
    }),
  );
  let baselineCriticalPath;
  if (baselineCaseShards) {
    const baselinePlan = planStageAwareShards({
      caseIds,
      hybridCaseIds,
      shardCount: baselineCaseShards.length,
      affinities,
      caseCosts,
      defaultCaseCosts,
      preferredSlotByBundle: {},
      activeExecuteStages: normalizedActiveExecuteStages,
      traceJobBudgetMs: resolvedFixedCosts.traceJobBudgetMs,
    });
    // Keep the current mapping, replacing only the planner's generated shards.
    const bundleByCase = new Map();
    const bundles = buildAffinityStageBundles({
      caseIds,
      hybridCaseIds,
      affinities,
      caseCosts,
      defaultCaseCosts,
      activeExecuteStages: normalizedActiveExecuteStages,
    });
    bundles.forEach((bundle) =>
      bundle.caseIds.forEach((caseId) => bundleByCase.set(caseId, bundle)),
    );
    const seenBundles = new Set();
    const shardBundles = baselineCaseShards.map((shardCaseIds) => {
      const result = [];
      for (const caseId of shardCaseIds) {
        const bundle = bundleByCase.get(caseId);
        if (bundle && !seenBundles.has(bundle.id)) {
          seenBundles.add(bundle.id);
          result.push(bundle);
        }
      }
      return result;
    });
    const shardStageCosts = shardBundles.map((items) =>
      items.reduce(
        (costs, bundle) =>
          addBundleCosts({
            current: costs,
            bundle,
            traceJobBudgetMs: resolvedFixedCosts.traceJobBudgetMs,
          }),
        emptyStageCosts(),
      ),
    );
    baselineCriticalPath = attachCandidateMetrics({
      plan: {
        ...baselinePlan,
        caseShards: baselineCaseShards.map((caseIds) => caseIds.slice()),
        shardStageCosts,
        stageMaxima: resolveStageMaxima({ shardStageCosts, shardBundles }),
      },
      fixedCosts: resolvedFixedCosts,
      coldSloMs,
      warmSloMs,
    }).criticalPath;
  }
  const eligible = candidates.filter(
    ({ criticalPath }) =>
      criticalPath.meetsColdSlo &&
      criticalPath.meetsWarmSlo &&
      (baselineCriticalPath == null ||
        (criticalPath.coldWallMs <= baselineCriticalPath.coldWallMs &&
          criticalPath.warmWallMs <= baselineCriticalPath.warmWallMs)),
  );
  const selected =
    eligible[0] ??
    candidates
      .slice()
      .sort(
        (left, right) =>
          left.criticalPath.coldWallMs - right.criticalPath.coldWallMs ||
          left.criticalPath.warmWallMs - right.criticalPath.warmWallMs ||
          left.shardCount - right.shardCount,
      )[0];
  const observed = summarizeObserved(observedStages);
  const predicted = {
    ...selected.predictedStages,
    warmSeedMs: resolvedFixedCosts.warmSeedMs,
    coldWallMs: selected.criticalPath.coldWallMs,
    warmWallMs: selected.criticalPath.warmWallMs,
  };
  const calibrationDeltaMs = observed
    ? Object.fromEntries(
        STAGE_COST_KEYS.map((stage) => [
          stage,
          predicted[stage] - observed[stage],
        ]),
      )
    : null;

  return {
    selected,
    candidates,
    baselineCriticalPath: baselineCriticalPath ?? null,
    summary: {
      activeStages: STAGE_COST_KEYS.filter(
        (stage) =>
          stage === "coldSeedMs" ||
          stage === "traceMs" ||
          normalizedActiveExecuteStages.includes(stage),
      ),
      candidateShardCounts: sortedShardCounts,
      selectedShardCount: selected.shardCount,
      coldSloMs,
      warmSloMs,
      predicted,
      observed,
      calibrationDeltaMs,
    },
  };
};

const formatDuration = (durationMs) => `${Math.round(durationMs / 1000)}s`;

export const renderStagePlanSummaryMarkdown = ({
  selected,
  candidates,
  summary,
}) => {
  const first = summary.candidateShardCounts[0];
  const last = summary.candidateShardCounts.at(-1);
  const displayedStages = summary.activeStages ?? STAGE_COST_KEYS;
  const stageLabels = {
    coldSeedMs: "Cold seed",
    v1Ms: "V1",
    v2SyncMs: "V2 sync",
    v2HybridMs: "V2 hybrid",
    traceMs: "Trace",
  };
  const lines = [
    "## Stage-aware full-run plan",
    "",
    `Compared ${first} through ${last} shards; selected ${selected.shardCount}.`,
    "",
    `| Shards | ${displayedStages.map((stage) => stageLabels[stage]).join(" | ")} | Cold wall | Warm wall | Peak / total jobs | Cache movement |`,
    `| ---: | ${displayedStages.map(() => "---").join(" | ")} | ---: | ---: | ---: | ---: |`,
  ];
  for (const candidate of candidates) {
    const marker = candidate === selected ? " **selected**" : "";
    const stageCell = (stage) =>
      `${formatDuration(candidate.stageMaxima[stage].durationMs)} @ ${candidate.stageMaxima[stage].shard}`;
    lines.push(
      `| ${candidate.shardCount}${marker} | ${displayedStages.map(stageCell).join(" | ")} | ${formatDuration(candidate.criticalPath.coldWallMs)} | ${formatDuration(candidate.criticalPath.warmWallMs)} | ${candidate.concurrencyCost.peakJobs} / ${candidate.concurrencyCost.totalJobs} | ${formatDuration(candidate.estimatedCacheImpactMs)} |`,
    );
  }
  lines.push("", "### Predicted vs observed stage maxima", "");
  if (!summary.observed) {
    lines.push(
      summary.calibrationSource
        ? `Cost calibration source: run ${summary.calibrationSource.sourceRunId}. Current-run observations will be appended by the report job.`
        : "Current-run observations will be appended by the report job.",
    );
  } else {
    lines.push(
      `Calibration source: run ${summary.observed.sourceRunId}.`,
      "",
      "| Stage | Predicted | Observed | Delta | Critical shard |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const stage of displayedStages) {
      lines.push(
        `| ${stage} | ${formatDuration(summary.predicted[stage])} | ${formatDuration(summary.observed[stage])} | ${formatDuration(summary.calibrationDeltaMs[stage])} | ${selected.stageMaxima[stage].shard} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};
