import { STAGE_COST_KEYS } from "./stage-aware-shard-model.mjs";

const JOB_STAGE_PATTERNS = [
  {
    stage: "seedJobMs",
    pattern: /^Prepare perf seed DB \((shard-\d+-of-\d+)\)$/,
  },
  {
    stage: "v1Ms",
    pattern: /^Run perf cases \(v1-(shard-\d+-of-\d+)\)$/,
  },
  {
    stage: "v2SyncMs",
    pattern: /^Run perf cases \(v2-sync-default-(shard-\d+-of-\d+)\)$/,
  },
  {
    stage: "v2HybridMs",
    pattern: /^Run perf cases \(v2-hybrid-computed-(shard-\d+-of-\d+)\)$/,
  },
];

export const resolveTraceJobIdentity = (artifactPath, executionProfile = {}) => {
  const shard = /shard-\d+-of-\d+/.exec(artifactPath)?.[0];
  if (!shard) {
    return undefined;
  }
  if (
    /teable-ee-e2e-perf-(?:results-)?v2-hybrid-computed-shard-/.test(
      artifactPath,
    )
  ) {
    return { stage: "v2HybridMs", shard };
  }
  if (/teable-ee-e2e-perf-(?:results-)?v2-shard-/.test(artifactPath)) {
    return {
      stage:
        executionProfile.v2Mode === "hybrid" ? "v2HybridMs" : "v2SyncMs",
      shard,
    };
  }
  if (/teable-ee-e2e-perf-(?:results-)?v1-shard-/.test(artifactPath)) {
    return { stage: "v1Ms", shard };
  }
  return undefined;
};

const assertRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const assertNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const assertNonNegativeFinite = (value, label) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
};

const resolveJobStage = (name, executionProfile) => {
  for (const { stage, pattern } of JOB_STAGE_PATTERNS) {
    const match = pattern.exec(name);
    if (match) {
      return { stage, shard: match[1] };
    }
  }
  const unsplitV2 = /^Run perf cases \(v2-(shard-\d+-of-\d+)\)$/.exec(name);
  if (unsplitV2) {
    return {
      stage:
        executionProfile?.v2Mode === "hybrid"
          ? "v2HybridMs"
          : "v2SyncMs",
      shard: unsplitV2[1],
    };
  }
  return undefined;
};

const resolveJobDurationMs = (job) => {
  if (Number.isFinite(job.durationMs)) {
    return assertNonNegativeFinite(job.durationMs, `${job.name}.durationMs`);
  }
  if (!job.started_at || !job.completed_at) {
    return undefined;
  }
  const startedAtMs = Date.parse(job.started_at);
  const completedAtMs = Date.parse(job.completed_at);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    throw new Error(`${job.name} must have valid job timestamps.`);
  }
  if (completedAtMs < startedAtMs) {
    throw new Error(`${job.name} completed before it started.`);
  }
  return completedAtMs - startedAtMs;
};

const resolveObservedJobs = (jobs, traceWaitByJob, executionProfile) => {
  if (!Array.isArray(jobs)) {
    throw new Error("jobs must be an array.");
  }
  const observed = {};
  for (const jobInput of jobs) {
    const job = assertRecord(jobInput, "jobs[]");
    const name = assertNonEmptyString(job.name, "jobs[].name");
    const classified = resolveJobStage(name, executionProfile);
    if (!classified) {
      continue;
    }
    const rawDurationMs = resolveJobDurationMs(job);
    if (rawDurationMs == null) {
      continue;
    }
    const traceWaitMs =
      traceWaitByJob.get(`${classified.stage}:${classified.shard}`) ?? 0;
    const durationMs = Math.max(0, rawDurationMs - traceWaitMs);
    const current = observed[classified.stage];
    if (!current || durationMs > current.durationMs) {
      observed[classified.stage] = {
        durationMs,
        rawDurationMs,
        traceWaitMs,
        shard: classified.shard,
        jobName: name,
      };
    }
  }
  return observed;
};

const resolveTraceObservation = (traceObservation) => {
  if (traceObservation == null) {
    return {
      summary: undefined,
      waitByJob: new Map(),
    };
  }
  const trace = assertRecord(traceObservation, "traceObservation");
  const waitByJob = new Map();
  for (const waitInput of trace.jobWaits ?? []) {
    const wait = assertRecord(waitInput, "traceObservation.jobWaits[]");
    if (!["v1Ms", "v2SyncMs", "v2HybridMs"].includes(wait.stage)) {
      throw new Error(
        "traceObservation.jobWaits[].stage must be an execute stage.",
      );
    }
    const shard = assertNonEmptyString(
      wait.shard,
      "traceObservation.jobWaits[].shard",
    );
    const durationMs = assertNonNegativeFinite(
      wait.durationMs,
      "traceObservation.jobWaits[].durationMs",
    );
    const key = `${wait.stage}:${shard}`;
    waitByJob.set(key, Math.max(waitByJob.get(key) ?? 0, durationMs));
  }
  return {
    summary: {
      durationMs: assertNonNegativeFinite(
        trace.durationMs,
        "traceObservation.durationMs",
      ),
      shard: assertNonEmptyString(trace.shard, "traceObservation.shard"),
      jobName:
        typeof trace.source === "string" && trace.source.trim().length > 0
          ? trace.source
          : "trace manifest job wait",
    },
    waitByJob,
  };
};

export const summarizeSeedCacheStatuses = (statuses) => {
  if (!Array.isArray(statuses)) {
    throw new Error("seed cache statuses must be an array.");
  }
  const modeCounts = {};
  for (const statusInput of statuses) {
    const status = assertRecord(statusInput, "seed cache statuses[]");
    const mode = assertNonEmptyString(status.mode, "seed cache statuses[].mode");
    modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
  }
  const modes = Object.keys(modeCounts);
  const mode =
    statuses.length === 0
      ? "unknown"
      : modes.length === 1 && modes[0] === "exact-hit"
        ? "warm"
        : modes.length === 1 && modes[0] === "cache-miss"
          ? "cold"
          : modes.length === 1 && modes[0] === "compatible-candidate"
            ? "compatible"
            : "mixed";
  return { mode, statusCount: statuses.length, modeCounts };
};

const resolveSeedCacheObservation = (
  seedCacheObservation,
  expectedStatusCount,
) => {
  if (seedCacheObservation == null) {
    return {
      mode: "unknown",
      statusCount: 0,
      modeCounts: {},
      predictionStage: undefined,
    };
  }
  const observation = assertRecord(
    seedCacheObservation,
    "seedCacheObservation",
  );
  const mode = assertNonEmptyString(
    observation.mode,
    "seedCacheObservation.mode",
  );
  if (!["cold", "warm", "compatible", "mixed", "unknown"].includes(mode)) {
    throw new Error(`Unsupported seed cache observation mode: ${mode}.`);
  }
  const statusCount = assertNonNegativeFinite(
      observation.statusCount ?? 0,
      "seedCacheObservation.statusCount",
    );
  const complete = statusCount === expectedStatusCount;
  return {
    mode: complete ? mode : "incomplete",
    detectedMode: mode,
    statusCount,
    modeCounts: assertRecord(
      observation.modeCounts ?? {},
      "seedCacheObservation.modeCounts",
    ),
    predictionStage:
      complete && mode === "cold"
        ? "coldSeedMs"
        : complete && mode === "warm"
          ? "warmSeedMs"
          : undefined,
  };
};

export const observeStagePlan = ({
  planSummary,
  jobs,
  traceObservation,
  seedCacheObservation,
  sourceRunId,
}) => {
  const stagePlan = planSummary?.stagePlan;
  if (!stagePlan) {
    return null;
  }
  assertNonEmptyString(sourceRunId, "sourceRunId");
  const selected = stagePlan.candidates?.find(
    ({ shardCount }) => shardCount === stagePlan.selectedShardCount,
  );
  if (!selected) {
    throw new Error("stagePlan must include its selected candidate.");
  }
  const activeStages = stagePlan.activeStages ?? STAGE_COST_KEYS;
  const invalidActiveStages = activeStages.filter(
    (stage) => !STAGE_COST_KEYS.includes(stage),
  );
  if (invalidActiveStages.length > 0) {
    throw new Error(
      `Unsupported active stage(s): ${invalidActiveStages.join(", ")}.`,
    );
  }
  const resolvedTrace = resolveTraceObservation(traceObservation);
  const observedJobs = resolveObservedJobs(
    jobs,
    resolvedTrace.waitByJob,
    stagePlan.executionProfile,
  );
  const resolvedSeedCache = resolveSeedCacheObservation(
    seedCacheObservation,
    stagePlan.selectedShardCount,
  );
  const comparedStages = [
    ...(resolvedSeedCache.predictionStage
      ? [resolvedSeedCache.predictionStage]
      : []),
    ...activeStages.filter((stage) => stage !== "coldSeedMs"),
  ];
  const predicted = Object.fromEntries(
    comparedStages.map((stage) => [
      stage,
      {
        durationMs: assertNonNegativeFinite(
          stagePlan.predicted?.[stage],
          `stagePlan.predicted.${stage}`,
        ),
        shard:
          stage === "warmSeedMs"
            ? "all seed shards"
            : assertNonEmptyString(
                selected.stageMaxima?.[stage]?.shard,
                `selected.stageMaxima.${stage}.shard`,
              ),
      },
    ]),
  );
  const observed = Object.fromEntries(
    comparedStages.flatMap((stage) => {
      const value =
        stage === "coldSeedMs" || stage === "warmSeedMs"
          ? observedJobs.seedJobMs
          : stage === "traceMs"
            ? resolvedTrace.summary
            : observedJobs[stage];
      return value == null ? [] : [[stage, value]];
    }),
  );
  const missingStages = comparedStages.filter(
    (stage) => observed[stage] == null,
  );
  if (!resolvedSeedCache.predictionStage) {
    missingStages.unshift("seedCacheMode");
  }
  const driftMs = Object.fromEntries(
    comparedStages.map((stage) => [
      stage,
      observed[stage] == null
        ? null
        : observed[stage].durationMs - predicted[stage].durationMs,
    ]),
  );

  return {
    sourceRunId,
    selectedShardCount: stagePlan.selectedShardCount,
    cacheMode: resolvedSeedCache.mode,
    seedCacheObservation: {
      statusCount: resolvedSeedCache.statusCount,
      modeCounts: resolvedSeedCache.modeCounts,
      detectedMode: resolvedSeedCache.detectedMode,
    },
    seedPredictionStage: resolvedSeedCache.predictionStage ?? null,
    comparedStages,
    complete: missingStages.length === 0,
    missingStages,
    predicted,
    observed,
    driftMs,
  };
};

const formatDuration = (durationMs) => {
  if (durationMs == null) {
    return "n/a";
  }
  const sign = durationMs > 0 ? "+" : durationMs < 0 ? "-" : "";
  const seconds = Math.round(Math.abs(durationMs) / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const body =
    minutes > 0
      ? `${minutes}m${String(remainder).padStart(2, "0")}s`
      : `${seconds}s`;
  return `${sign}${body}`;
};

export const renderStagePlanObservationMarkdown = (observationInput) => {
  const observation = assertRecord(observationInput, "observation");
  const lines = [
    "## Current-run predicted vs observed stages",
    "",
    `Run ${observation.sourceRunId} · selected ${observation.selectedShardCount} shards · ${observation.complete ? "complete" : "partial"}.`,
    "",
    "| Stage | Predicted | Observed | Observed - predicted | Predicted critical | Observed critical |",
    "| --- | ---: | ---: | ---: | --- | --- |",
  ];
  for (const stage of observation.comparedStages) {
    lines.push(
      `| ${stage} | ${formatDuration(observation.predicted[stage].durationMs)} | ${formatDuration(observation.observed[stage]?.durationMs)} | ${formatDuration(observation.driftMs[stage])} | ${observation.predicted[stage].shard} | ${observation.observed[stage]?.shard ?? "n/a"} |`,
    );
  }
  if (observation.missingStages.length > 0) {
    lines.push(
      "",
      `Missing observed stages: ${observation.missingStages.join(", ")}.`,
    );
  }
  lines.push(
    "",
    `Seed cache mode: ${observation.cacheMode}; prediction basis: ${observation.seedPredictionStage ?? "unclassified"}.`,
  );
  return `${lines.join("\n")}\n`;
};
