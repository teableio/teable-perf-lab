const MINUTE_MS = 60_000;

export const FULL_RUN_FEEDBACK_STAGES = Object.freeze([
  "seed",
  "v1",
  "v2-sync",
  "v2-hybrid",
  "report",
]);

export const FULL_RUN_FEEDBACK_PHASES = Object.freeze([
  "seed",
  "execute",
  "report",
]);

export const DEFAULT_FULL_RUN_FEEDBACK_SLO = Object.freeze({
  coldWallMs: 45 * MINUTE_MS,
  warmWallMs: 25 * MINUTE_MS,
  traceCaseWaitMs: 15_000,
  traceJobWaitMs: 60_000,
});

export const formatFeedbackDuration = (durationMs) => {
  const totalSeconds = Math.round(
    assertNonNegativeNumber(durationMs, "durationMs") / 1_000,
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
};

const assertRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const assertNonEmptyArray = (value, label) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
};

const assertNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const assertNonNegativeNumber = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
};

const parseTimestamp = (value, label) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return timestamp;
};

const resolveTimeWindow = (windowInput, label) => {
  const window = assertRecord(windowInput, label);
  const startedAtMs = parseTimestamp(window.startedAt, `${label}.startedAt`);
  const completedAtMs = parseTimestamp(
    window.completedAt,
    `${label}.completedAt`,
  );
  if (completedAtMs < startedAtMs) {
    throw new Error(
      `${label}.completedAt must not precede ${label}.startedAt.`,
    );
  }
  return {
    startedAt: window.startedAt,
    completedAt: window.completedAt,
    startedAtMs,
    completedAtMs,
    durationMs: completedAtMs - startedAtMs,
  };
};

const assertKnownValue = (value, allowedValues, label) => {
  if (!allowedValues.includes(value)) {
    throw new Error(`${label} must be one of ${allowedValues.join(", ")}.`);
  }
  return value;
};

const resolvePlan = (planInput) => {
  const plan = assertRecord(planInput, "plan");
  const requiredStages = assertNonEmptyArray(
    plan.requiredStages,
    "plan.requiredStages",
  ).map((stage, index) =>
    assertKnownValue(
      stage,
      FULL_RUN_FEEDBACK_STAGES,
      `plan.requiredStages[${index}]`,
    ),
  );
  const uniqueStages = new Set(requiredStages);
  if (
    requiredStages.length !== FULL_RUN_FEEDBACK_STAGES.length ||
    uniqueStages.size !== FULL_RUN_FEEDBACK_STAGES.length ||
    !FULL_RUN_FEEDBACK_STAGES.every((stage) => uniqueStages.has(stage))
  ) {
    throw new Error(
      `plan.requiredStages must contain each full-run stage exactly once: ${FULL_RUN_FEEDBACK_STAGES.join(", ")}.`,
    );
  }

  return {
    requiredStages: [...FULL_RUN_FEEDBACK_STAGES],
    expectedResults: assertNonNegativeNumber(
      plan.expectedResults,
      "plan.expectedResults",
    ),
  };
};

const resolvePhases = (phasesInput) => {
  const phases = assertRecord(phasesInput, "phases");
  for (const phase of Object.keys(phases)) {
    assertKnownValue(phase, FULL_RUN_FEEDBACK_PHASES, `phases.${phase}`);
  }

  return Object.fromEntries(
    FULL_RUN_FEEDBACK_PHASES.map((phase) => {
      const window = resolveTimeWindow(phases[phase], `phases.${phase}`);
      return [
        phase,
        {
          startedAt: window.startedAt,
          completedAt: window.completedAt,
          durationMs: window.durationMs,
        },
      ];
    }),
  );
};

const resolveTiming = (telemetry, slo) => {
  const workflow = resolveTimeWindow(telemetry.workflow, "workflow");
  const queuedAtMs = parseTimestamp(
    telemetry.workflow.queuedAt,
    "workflow.queuedAt",
  );
  if (workflow.startedAtMs < queuedAtMs) {
    throw new Error("workflow.startedAt must not precede workflow.queuedAt.");
  }

  const targetWallMs =
    telemetry.cacheMode === "cold"
      ? slo.coldWallMs
      : telemetry.cacheMode === "warm"
        ? slo.warmWallMs
        : undefined;
  if (targetWallMs == null) {
    throw new Error('cacheMode must be either "cold" or "warm".');
  }

  return {
    queueMs: workflow.startedAtMs - queuedAtMs,
    activeWallMs: workflow.durationMs,
    targetWallMs,
  };
};

const resolveCriticalJobs = (jobsInput, plan) => {
  const jobs = assertNonEmptyArray(jobsInput, "jobs");
  const criticalByStage = new Map();
  for (const job of jobs) {
    assertRecord(job, "jobs[]");
    const name = assertNonEmptyString(job.name, "jobs[].name");
    const stage = assertKnownValue(
      job.stage,
      FULL_RUN_FEEDBACK_STAGES,
      `jobs[${name}].stage`,
    );
    if (stage !== "report") {
      assertNonEmptyString(job.shard, `jobs[${name}].shard`);
    }
    const durationMs = assertNonNegativeNumber(
      job.durationMs,
      `jobs[${name}].durationMs`,
    );
    const current = criticalByStage.get(stage);
    if (!current || durationMs > current.durationMs) {
      criticalByStage.set(stage, { ...job, name, stage, durationMs });
    }
  }

  for (const stage of plan.requiredStages) {
    if (!criticalByStage.has(stage)) {
      throw new Error(`jobs must include at least one ${stage} stage job.`);
    }
  }

  return Object.fromEntries(
    plan.requiredStages.map((stage) => [stage, criticalByStage.get(stage)]),
  );
};

const resolveDuplicateSeeds = (observationsInput) => {
  const observations = assertNonEmptyArray(
    observationsInput,
    "seedObservations",
  );
  const bySeedHash = new Map();

  for (const observation of observations) {
    assertRecord(observation, "seedObservations[]");
    const caseId = assertNonEmptyString(
      observation.caseId,
      "seedObservations[].caseId",
    );
    const shard = assertNonEmptyString(
      observation.shard,
      `seedObservations[${caseId}].shard`,
    );
    const seedHash = assertNonEmptyString(
      observation.seedHash,
      `seedObservations[${caseId}].seedHash`,
    );
    if (observation.affinityId != null) {
      assertNonEmptyString(
        observation.affinityId,
        `seedObservations[${caseId}].affinityId`,
      );
    }
    const buildMs = assertNonNegativeNumber(
      observation.buildMs,
      `seedObservations[${caseId}].buildMs`,
    );

    const seedGroup = bySeedHash.get(seedHash) ?? {
      byShard: new Map(),
      affinityIds: new Set(),
      missingAffinity: false,
    };
    if (observation.affinityId != null) {
      seedGroup.affinityIds.add(observation.affinityId);
    } else {
      seedGroup.missingAffinity = true;
    }
    const byShard = seedGroup.byShard;
    const shardObservation = byShard.get(shard) ?? {
      buildMs: 0,
      caseIds: [],
    };
    shardObservation.buildMs = Math.max(shardObservation.buildMs, buildMs);
    if (!shardObservation.caseIds.includes(caseId)) {
      shardObservation.caseIds.push(caseId);
    }
    byShard.set(shard, shardObservation);
    bySeedHash.set(seedHash, seedGroup);
  }

  const duplicates = [];
  for (const [seedHash, seedGroup] of bySeedHash) {
    const { byShard } = seedGroup;
    if (byShard.size < 2) {
      continue;
    }
    const shardEntries = [...byShard.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const buildTimes = shardEntries.map(([, value]) => value.buildMs);
    const totalBuildMs = buildTimes.reduce((total, value) => total + value, 0);
    const requiredBuildMs = Math.max(...buildTimes);
    const affinityIds = [...seedGroup.affinityIds].sort();
    duplicates.push({
      seedHash,
      affinityIds,
      staticAffinityIssue: seedGroup.missingAffinity
        ? "missing-affinity-declaration"
        : affinityIds.length === 1
          ? "declared-affinity-spans-shards"
          : "seed-hash-maps-to-multiple-affinities",
      shards: shardEntries.map(([shard]) => shard),
      caseIds: shardEntries.flatMap(([, value]) => value.caseIds),
      totalBuildMs,
      requiredBuildMs,
      avoidableBuildMs: totalBuildMs - requiredBuildMs,
    });
  }

  return {
    duplicates,
    avoidableBuildMs: duplicates.reduce(
      (total, duplicate) => total + duplicate.avoidableBuildMs,
      0,
    ),
  };
};

const maxWaitObservation = (observationsInput, label, requiredFields) => {
  const observations = assertNonEmptyArray(observationsInput, label);
  let maximum;
  for (const observation of observations) {
    assertRecord(observation, `${label}[]`);
    for (const field of requiredFields) {
      assertNonEmptyString(observation[field], `${label}[].${field}`);
    }
    const waitMs = assertNonNegativeNumber(
      observation.waitMs,
      `${label}[].waitMs`,
    );
    if (!maximum || waitMs > maximum.waitMs) {
      maximum = { ...observation, waitMs };
    }
  }
  return maximum;
};

const resolveTrace = (traceInput) => {
  const trace = assertRecord(traceInput, "trace");
  return {
    missingFetchCount: assertNonNegativeNumber(
      trace.missingFetchCount,
      "trace.missingFetchCount",
    ),
    wastedFetchMs: assertNonNegativeNumber(
      trace.wastedFetchMs,
      "trace.wastedFetchMs",
    ),
    maxCaseWait: maxWaitObservation(trace.cases, "trace.cases", [
      "caseId",
      "engine",
      "shard",
    ]),
    maxJobWait: maxWaitObservation(trace.jobs, "trace.jobs", ["name"]),
  };
};

const resolveCoverage = (coverageInput, plan) => {
  const coverage = assertRecord(coverageInput, "coverage");
  const resolved = {
    expectedResults: assertNonNegativeNumber(
      coverage.expectedResults,
      "coverage.expectedResults",
    ),
    observedResults: assertNonNegativeNumber(
      coverage.observedResults,
      "coverage.observedResults",
    ),
  };
  if (resolved.expectedResults !== plan.expectedResults) {
    throw new Error(
      "coverage.expectedResults must equal plan.expectedResults.",
    );
  }
  return resolved;
};

export const evaluateFullRunFeedback = (
  telemetryInput,
  { slo = DEFAULT_FULL_RUN_FEEDBACK_SLO } = {},
) => {
  const telemetry = assertRecord(telemetryInput, "telemetry");
  const runId = assertNonEmptyString(telemetry.runId, "runId");
  const plan = resolvePlan(telemetry.plan);
  const timing = resolveTiming(telemetry, slo);
  const phases = resolvePhases(telemetry.phases);
  const criticalJobs = resolveCriticalJobs(telemetry.jobs, plan);
  const seed = resolveDuplicateSeeds(telemetry.seedObservations);
  const trace = resolveTrace(telemetry.trace);
  const coverage = resolveCoverage(telemetry.coverage, plan);
  const failures = [];

  if (timing.activeWallMs > timing.targetWallMs) {
    failures.push({
      code: "active-wall",
      actualMs: timing.activeWallMs,
      targetMs: timing.targetWallMs,
    });
  }
  if (seed.duplicates.length > 0) {
    failures.push({
      code: "cross-shard-seed-duplication",
      duplicateCount: seed.duplicates.length,
      avoidableBuildMs: seed.avoidableBuildMs,
    });
  }
  if (coverage.observedResults !== coverage.expectedResults) {
    failures.push({
      code: "result-coverage",
      actual: coverage.observedResults,
      expected: coverage.expectedResults,
    });
  }
  if ((trace.maxCaseWait?.waitMs ?? 0) > slo.traceCaseWaitMs) {
    failures.push({
      code: "trace-case-budget",
      actualMs: trace.maxCaseWait.waitMs,
      targetMs: slo.traceCaseWaitMs,
      observation: trace.maxCaseWait,
    });
  }
  if ((trace.maxJobWait?.waitMs ?? 0) > slo.traceJobWaitMs) {
    failures.push({
      code: "trace-job-budget",
      actualMs: trace.maxJobWait.waitMs,
      targetMs: slo.traceJobWaitMs,
      observation: trace.maxJobWait,
    });
  }

  return {
    runId,
    cacheMode: telemetry.cacheMode,
    passed: failures.length === 0,
    plan,
    timing,
    phases,
    coverage,
    criticalJobs,
    seed,
    trace,
    failures,
  };
};

export const renderFullRunFeedback = (evaluationInput) => {
  const evaluation = assertRecord(evaluationInput, "evaluation");
  const timing = assertRecord(evaluation.timing, "evaluation.timing");
  const phases = assertRecord(evaluation.phases, "evaluation.phases");
  const seed = assertRecord(evaluation.seed, "evaluation.seed");
  const trace = assertRecord(evaluation.trace, "evaluation.trace");
  const criticalJobs = assertRecord(
    evaluation.criticalJobs,
    "evaluation.criticalJobs",
  );
  const failures = Array.isArray(evaluation.failures)
    ? evaluation.failures
    : [];
  const lines = [
    `Full CI feedback: ${evaluation.passed ? "PASS" : "FAIL"}`,
    `Run ${evaluation.runId} · ${evaluation.cacheMode} · active ${formatFeedbackDuration(
      timing.activeWallMs,
    )} / target ${formatFeedbackDuration(timing.targetWallMs)} · queue ${formatFeedbackDuration(
      timing.queueMs,
    )}`,
  ];

  lines.push(
    `Phases: ${FULL_RUN_FEEDBACK_PHASES.map(
      (phase) =>
        `${phase} ${formatFeedbackDuration(
          assertRecord(phases[phase], `evaluation.phases.${phase}`).durationMs,
        )}`,
    ).join(" · ")}`,
  );

  const critical = Object.entries(criticalJobs).map(
    ([stage, job]) =>
      `${stage} ${job.name} ${formatFeedbackDuration(job.durationMs)}`,
  );
  lines.push(
    `Critical jobs: ${critical.length > 0 ? critical.join(" · ") : "none"}`,
  );
  lines.push(
    `Seed duplication: ${seed.duplicates.length} identities · avoidable ${formatFeedbackDuration(
      seed.avoidableBuildMs,
    )}`,
  );
  for (const duplicate of seed.duplicates) {
    lines.push(
      `Seed ${duplicate.seedHash}: ${duplicate.shards.join(", ")} · affinity ${
        duplicate.affinityIds.length > 0
          ? duplicate.affinityIds.join(", ")
          : "unknown"
      } · cases ${duplicate.caseIds.join(", ")} · avoidable ${formatFeedbackDuration(
        duplicate.avoidableBuildMs,
      )} · static affinity ${duplicate.staticAffinityIssue ?? "unclassified"}`,
    );
  }
  lines.push(
    `Trace: ${trace.missingFetchCount} missing · wasted ${formatFeedbackDuration(
      trace.wastedFetchMs,
    )} · max case ${formatFeedbackDuration(
      trace.maxCaseWait?.waitMs ?? 0,
    )} · max job ${formatFeedbackDuration(trace.maxJobWait?.waitMs ?? 0)}`,
  );
  if (trace.maxCaseWait) {
    lines.push(
      `Trace case: ${trace.maxCaseWait.caseId ?? "unknown"} · ${
        trace.maxCaseWait.engine ?? "unknown"
      } · ${trace.maxCaseWait.shard ?? "unknown"} · ${formatFeedbackDuration(
        trace.maxCaseWait.waitMs,
      )}`,
    );
  }
  if (trace.maxJobWait) {
    lines.push(
      `Trace job: ${trace.maxJobWait.name ?? "unknown"} · ${formatFeedbackDuration(
        trace.maxJobWait.waitMs,
      )}`,
    );
  }

  if (evaluation.coverage) {
    lines.push(
      `Coverage: ${evaluation.coverage.observedResults}/${evaluation.coverage.expectedResults}`,
    );
  }
  if (failures.length > 0) {
    lines.push(
      `Failures: ${failures.map((failure) => failure.code).join(", ")}`,
    );
  }

  return lines.join("\n");
};
