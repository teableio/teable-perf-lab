import { createHash } from "node:crypto";

export const DEFAULT_PAIRED_POLICY = Object.freeze({
  practicalRegression: 0.1,
  minPairs: 10,
  confidence: 0.95,
  falseDiscoveryRate: 0.05,
  bootstrapResamples: 9_999,
  permutationResamples: 9_999,
  environmentDriftLimit: 0.2,
});

const hashSeed = (value) =>
  Number.parseInt(
    createHash("sha256").update(String(value)).digest("hex").slice(0, 8),
    16,
  ) || 1;

const rngOf = (seed) => {
  let state = Number(seed) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const sampleDeviation = (values) => {
  if (values.length < 2) return 0;
  const centre = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - centre) ** 2, 0) /
      (values.length - 1),
  );
};

const quantile = (values, probability) => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const primaryValue = (payload) => {
  const threshold = Array.isArray(payload?.thresholds)
    ? payload.thresholds[0]
    : undefined;
  const value = Number(threshold?.actual);
  return value > 0 ? value : undefined;
};

export const isFullCommitSha = (value) =>
  /^[0-9a-f]{40}$/i.test(String(value ?? ""));

export const assertFullCommitSha = (value, label) => {
  if (!isFullCommitSha(value)) {
    throw new Error(
      `${label} must be a full immutable 40-character commit SHA`,
    );
  }
};

export const buildPairedExecutionOrder = ({ pairs, seed = 1 } = {}) => {
  if (!Number.isSafeInteger(pairs) || pairs <= 0) {
    throw new Error(`pairs must be a positive integer, received ${pairs}`);
  }
  const startsWithCandidate = hashSeed(seed) % 2 === 0;
  return Array.from({ length: pairs }, (_, index) => {
    const candidateFirst = (index % 2 === 0) === startsWithCandidate;
    const variants = candidateFirst
      ? ["candidate", "base"]
      : ["base", "candidate"];
    return {
      pairId: `pair-${String(index + 1).padStart(2, "0")}`,
      sampleIndex: index,
      order: candidateFirst ? "candidate-base" : "base-candidate",
      variants,
    };
  });
};

export const buildPairedPlan = ({
  experimentId,
  baseSha,
  candidateSha,
  perfLabSha,
  caseFilter,
  caseIds,
  engine = "v2",
  pairs = 10,
  schemaSignature,
}) => {
  assertFullCommitSha(baseSha, "baseSha");
  assertFullCommitSha(candidateSha, "candidateSha");
  assertFullCommitSha(perfLabSha, "perfLabSha");
  const plannedCaseIds = [...new Set((caseIds ?? []).filter(Boolean))].sort();
  if (
    !experimentId ||
    !caseFilter ||
    !schemaSignature ||
    plannedCaseIds.length === 0
  ) {
    throw new Error(
      "experimentId, caseFilter, caseIds, and schemaSignature are required",
    );
  }
  return {
    experimentId,
    baseSha,
    candidateSha,
    perfLabSha,
    caseFilter,
    caseIds: plannedCaseIds,
    engine,
    schemaSignature,
    order: buildPairedExecutionOrder({ pairs, seed: experimentId }),
  };
};

const bootstrapMeanInterval = ({ values, confidence, resamples, seed }) => {
  if (values.length === 1) return [values[0], values[0]];
  const random = rngOf(seed);
  const estimates = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    estimates.push(total / values.length);
  }
  const tail = (1 - confidence) / 2;
  return [quantile(estimates, tail), quantile(estimates, 1 - tail)];
};

const oneSidedSignFlipPValue = ({ values, resamples, seed }) => {
  const observed = mean(values);
  if (!(observed > 0)) return 1;
  const exact = values.length <= 16;
  const trials = exact ? 2 ** values.length : resamples;
  const random = exact ? undefined : rngOf(seed);
  let asExtreme = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      const positive = exact ? (trial & (1 << index)) !== 0 : random() >= 0.5;
      total += positive ? values[index] : -values[index];
    }
    if (total / values.length >= observed - Number.EPSILON) {
      asExtreme += 1;
    }
  }
  return exact ? asExtreme / trials : (asExtreme + 1) / (trials + 1);
};

export const benjaminiHochbergAdjusted = (pValues = []) => {
  const ranked = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((left, right) => left.pValue - right.pValue);
  const adjusted = Array(pValues.length).fill(1);
  let next = 1;
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const rank = index + 1;
    const value = Math.min(
      next,
      (ranked[index].pValue * ranked.length) / rank,
      1,
    );
    adjusted[ranked[index].index] = value;
    next = value;
  }
  return adjusted;
};

const pairPayloads = (payloads = []) => {
  const cases = new Map();
  for (const payload of payloads) {
    const execution = payload?.measurement?.execution;
    if (execution?.lane !== "paired" || !execution.pairId) continue;
    if (execution.variant !== "base" && execution.variant !== "candidate") {
      continue;
    }
    const casePairs = cases.get(payload.caseId) ?? new Map();
    const pair = casePairs.get(execution.pairId) ?? {};
    if (pair[execution.variant]) pair.duplicate = true;
    pair[execution.variant] = payload;
    casePairs.set(execution.pairId, pair);
    cases.set(payload.caseId, casePairs);
  }
  return cases;
};

const environmentControlRatio = (candidate, base, key) => {
  const candidateValue = Number(candidate?.measurement?.environment?.[key]);
  const baseValue = Number(base?.measurement?.environment?.[key]);
  return candidateValue > 0 && baseValue > 0
    ? candidateValue / baseValue
    : undefined;
};

export const pairedSamplesFromPayloads = (payloads = []) => {
  const result = {};
  for (const [caseId, pairs] of pairPayloads(payloads)) {
    const samples = [];
    const excluded = [];
    for (const [pairId, pair] of pairs) {
      if (pair.duplicate) {
        excluded.push({ pairId, reason: "duplicate-pair-variant" });
        continue;
      }
      if (!pair.base || !pair.candidate) {
        excluded.push({ pairId, reason: "incomplete-pair" });
        continue;
      }
      const baseValue = primaryValue(pair.base);
      const candidateValue = primaryValue(pair.candidate);
      if (!(baseValue > 0) || !(candidateValue > 0)) {
        excluded.push({ pairId, reason: "missing-primary-metric" });
        continue;
      }
      if (pair.base.result !== "pass" || pair.candidate.result !== "pass") {
        excluded.push({ pairId, reason: "failed-correctness" });
        continue;
      }
      const baseContract = pair.base.measurement?.contract?.id;
      const candidateContract = pair.candidate.measurement?.contract?.id;
      if (!baseContract || baseContract !== candidateContract) {
        excluded.push({ pairId, reason: "contract-mismatch" });
        continue;
      }
      const baseExperiment = pair.base.measurement?.execution?.experimentId;
      const candidateExperiment =
        pair.candidate.measurement?.execution?.experimentId;
      if (!baseExperiment || baseExperiment !== candidateExperiment) {
        excluded.push({ pairId, reason: "experiment-mismatch" });
        continue;
      }
      const baseClass = pair.base.measurement?.environment?.class;
      const candidateClass = pair.candidate.measurement?.environment?.class;
      if (!baseClass || baseClass !== candidateClass) {
        excluded.push({ pairId, reason: "environment-class-mismatch" });
        continue;
      }
      const baseFingerprint = pair.base.measurement?.environment?.fingerprint;
      const candidateFingerprint =
        pair.candidate.measurement?.environment?.fingerprint;
      if (
        !baseFingerprint ||
        !candidateFingerprint ||
        baseFingerprint !== candidateFingerprint
      ) {
        excluded.push({ pairId, reason: "environment-fingerprint-mismatch" });
        continue;
      }
      const baseExecution = pair.base.measurement?.execution;
      const candidateExecution = pair.candidate.measurement?.execution;
      if (
        !baseExecution?.pairOrder ||
        baseExecution.pairOrder !== candidateExecution?.pairOrder ||
        !["base-candidate", "candidate-base"].includes(baseExecution.pairOrder)
      ) {
        excluded.push({ pairId, reason: "pair-order-mismatch" });
        continue;
      }
      if (
        !Number.isSafeInteger(baseExecution.sampleIndex) ||
        baseExecution.sampleIndex < 0 ||
        baseExecution.sampleIndex !== candidateExecution?.sampleIndex
      ) {
        excluded.push({ pairId, reason: "sample-index-mismatch" });
        continue;
      }
      if (
        !isFullCommitSha(baseExecution.perfLabSha) ||
        baseExecution.perfLabSha !== candidateExecution?.perfLabSha
      ) {
        excluded.push({ pairId, reason: "perf-lab-sha-mismatch" });
        continue;
      }
      if (
        !isFullCommitSha(baseExecution.teableEeSha) ||
        !isFullCommitSha(candidateExecution?.teableEeSha)
      ) {
        excluded.push({ pairId, reason: "product-sha-missing" });
        continue;
      }
      if (
        !baseExecution.jobId ||
        baseExecution.jobId !== candidateExecution?.jobId ||
        !baseExecution.shardId ||
        baseExecution.shardId !== candidateExecution?.shardId
      ) {
        excluded.push({ pairId, reason: "execution-provenance-mismatch" });
        continue;
      }
      samples.push({
        pairId,
        base: baseValue,
        candidate: candidateValue,
        logRatio: Math.log(candidateValue / baseValue),
        cpuCanaryRatio: environmentControlRatio(
          pair.candidate,
          pair.base,
          "cpuCanaryMs",
        ),
        databaseCanaryRatio: environmentControlRatio(
          pair.candidate,
          pair.base,
          "databaseCanaryMs",
        ),
        contractId: baseContract,
        environmentClass: baseClass,
        environmentFingerprint: baseFingerprint,
        experimentId: baseExperiment,
        pairOrder: baseExecution.pairOrder,
        sampleIndex: baseExecution.sampleIndex,
        perfLabSha: baseExecution.perfLabSha,
        baseTeableEeSha: baseExecution.teableEeSha,
        candidateTeableEeSha: candidateExecution.teableEeSha,
        jobId: baseExecution.jobId,
        shardId: baseExecution.shardId,
      });
    }
    result[caseId] = { samples, excluded };
  }
  return result;
};

const environmentDriftOf = (samples, limit) => {
  const control = (key) => {
    const ratios = samples
      .map((sample) => sample[key])
      .filter((value) => Number.isFinite(value) && value > 0);
    if (ratios.length !== samples.length) {
      return { status: "unmeasured", observations: ratios.length };
    }
    const logs = ratios.map(Math.log);
    const ratio = Math.exp(mean(logs));
    const typicalMagnitudeRatio = Math.exp(median(logs.map(Math.abs)));
    return {
      status: typicalMagnitudeRatio > 1 + limit ? "drifted" : "stable",
      ratio,
      typicalMagnitudeRatio,
      observations: ratios.length,
    };
  };
  const controls = {
    cpu: control("cpuCanaryRatio"),
    database: control("databaseCanaryRatio"),
  };
  const measured = Object.values(controls).filter(
    (entry) => entry.status !== "unmeasured",
  );
  if (measured.length !== Object.keys(controls).length) {
    return { status: "unmeasured", controls };
  }
  return {
    status: measured.some((entry) => entry.status === "drifted")
      ? "drifted"
      : "stable",
    controls,
  };
};

const identityOf = (samples) => {
  const unique = (values) => [...new Set(values.filter(Boolean))].sort();
  return {
    contractIds: unique(samples.map((sample) => sample.contractId)),
    environmentClasses: unique(
      samples.map((sample) => sample.environmentClass),
    ),
    environmentFingerprints: unique(
      samples.map((sample) => sample.environmentFingerprint),
    ),
    experimentIds: unique(samples.map((sample) => sample.experimentId)),
    pairOrders: unique(samples.map((sample) => sample.pairOrder)),
    perfLabShas: unique(samples.map((sample) => sample.perfLabSha)),
    baseTeableEeShas: unique(samples.map((sample) => sample.baseTeableEeSha)),
    candidateTeableEeShas: unique(
      samples.map((sample) => sample.candidateTeableEeSha),
    ),
    jobIds: unique(samples.map((sample) => sample.jobId)),
    shardIds: unique(samples.map((sample) => sample.shardId)),
  };
};

const cohortIssueOf = (samples, identity) => {
  const singletonFields = [
    "contractIds",
    "environmentClasses",
    "environmentFingerprints",
    "experimentIds",
    "perfLabShas",
    "baseTeableEeShas",
    "candidateTeableEeShas",
    "jobIds",
    "shardIds",
  ];
  if (singletonFields.some((field) => identity[field].length !== 1)) {
    return "incompatible-pair-cohort";
  }
  if (
    new Set(samples.map((sample) => sample.sampleIndex)).size !== samples.length
  ) {
    return "duplicate-sample-index";
  }
  const orderCounts = Object.fromEntries(
    ["base-candidate", "candidate-base"].map((order) => [
      order,
      samples.filter((sample) => sample.pairOrder === order).length,
    ]),
  );
  if (
    samples.length > 1 &&
    (orderCounts["base-candidate"] === 0 ||
      orderCounts["candidate-base"] === 0 ||
      Math.abs(orderCounts["base-candidate"] - orderCounts["candidate-base"]) >
        1)
  ) {
    return "unbalanced-pair-order";
  }
  return undefined;
};

export const evaluatePairedExperiment = ({
  payloads = [],
  policy: policyInput = {},
  seed = 7,
} = {}) => {
  const policy = { ...DEFAULT_PAIRED_POLICY, ...policyInput };
  const grouped = pairedSamplesFromPayloads(payloads);
  const cases = [];

  for (const [caseId, { samples, excluded }] of Object.entries(grouped)) {
    const environment = environmentDriftOf(
      samples,
      policy.environmentDriftLimit,
    );
    const identity = identityOf(samples);
    const cohortIssue = cohortIssueOf(samples, identity);
    if (
      excluded.length > 0 ||
      samples.length < policy.minPairs ||
      cohortIssue ||
      environment.status !== "stable"
    ) {
      cases.push({
        caseId,
        status: "inconclusive",
        evidenceLevel: "inconclusive",
        pairs: samples.length,
        excluded,
        environment,
        identity,
        reason:
          excluded.length > 0
            ? "excluded-pairs"
            : samples.length < policy.minPairs
              ? "insufficient-pairs"
              : cohortIssue
                ? cohortIssue
                : environment.status === "drifted"
                  ? "environment-control-drift"
                  : "environment-control-unmeasured",
      });
      continue;
    }

    const logRatios = samples.map((sample) => sample.logRatio);
    const estimateLog = mean(logRatios);
    const practicalLog = Math.log1p(policy.practicalRegression);
    const [lowerLog, upperLog] = bootstrapMeanInterval({
      values: logRatios,
      confidence: policy.confidence,
      resamples: policy.bootstrapResamples,
      seed: hashSeed(`${seed}:${caseId}:bootstrap`),
    });
    const pValue = oneSidedSignFlipPValue({
      values: logRatios.map((value) => value - practicalLog),
      resamples: policy.permutationResamples,
      seed: hashSeed(`${seed}:${caseId}:permutation`),
    });
    const deviation = sampleDeviation(logRatios);
    cases.push({
      caseId,
      status: "pending-correction",
      pairs: samples.length,
      excluded,
      environment,
      identity,
      ratio: Math.exp(estimateLog),
      confidenceInterval: [Math.exp(lowerLog), Math.exp(upperLog)],
      pValue,
      practicalRegression: policy.practicalRegression,
      mde80: Math.expm1((2.487 * deviation) / Math.sqrt(samples.length)),
    });
  }

  const testable = cases.filter(
    (entry) => entry.status === "pending-correction",
  );
  const adjusted = benjaminiHochbergAdjusted(
    testable.map((entry) => entry.pValue),
  );
  for (const [index, entry] of testable.entries()) {
    entry.adjustedPValue = adjusted[index];
    const budgetRatio = 1 + entry.practicalRegression;
    if (
      entry.confidenceInterval[0] > budgetRatio &&
      entry.adjustedPValue <= policy.falseDiscoveryRate
    ) {
      entry.status = "regression";
      entry.evidenceLevel = "code_regression";
    } else if (entry.ratio > budgetRatio) {
      entry.status = "candidate";
      entry.evidenceLevel = "anomaly_candidate";
    } else {
      entry.status = "pass";
      entry.evidenceLevel = "no_regression_detected";
    }
  }

  const counts = cases.reduce(
    (count, entry) => {
      count[entry.status] = (count[entry.status] ?? 0) + 1;
      return count;
    },
    { pass: 0, candidate: 0, regression: 0, inconclusive: 0 },
  );
  const status =
    cases.length === 0
      ? "inconclusive"
      : counts.regression
        ? "regression"
        : counts.inconclusive
          ? "inconclusive"
          : counts.candidate
            ? "candidate"
            : "pass";

  return {
    status,
    counts,
    cases: cases.sort((left, right) => (right.ratio ?? 0) - (left.ratio ?? 0)),
    policy,
    method: {
      effect: "geometric-mean-of-paired-ratios",
      interval: "seeded-paired-bootstrap",
      hypothesis: "one-sided-sign-flip-over-practical-budget",
      multipleTesting: "benjamini-hochberg",
    },
    reason: cases.length === 0 ? "no-comparable-cases" : undefined,
  };
};
