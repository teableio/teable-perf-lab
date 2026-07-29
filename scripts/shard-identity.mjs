// Shard and stage identity: one place that both writes and reads it.
//
// A full run's identity is a string. The planner builds `shard-N-of-M` and plan
// names like `v2-sync-default-shard-3-of-8`; GitHub embeds the plan name in a
// job title; the observer then recovers the stage by regex-matching that title.
// Encode and decode lived apart, with CI in between: the label was formatted in
// six places and parsed by four regexes that named the stages a fifth time.
//
// Defining both directions here means a change to the format cannot land on one
// side only, and `parseJobName(formatJobName(x)) === x` is a property a test can
// state. It also keeps the one lossy edge documented rather than rediscovered:
// the v2 sync stage is named `v2-sync-default` in a job title but its artifacts
// carry the suffix `v2`, so an artifact path alone cannot tell sync from hybrid.

const SHARD_LABEL_PATTERN = /^shard-(\d+)-of-(\d+)$/;

/** `shard-3-of-8` from a zero-based index. */
export const formatShardLabel = (shardIndex, shardCount) =>
  `shard-${shardIndex + 1}-of-${shardCount}`;

/** `{ shardNumber, shardCount }`, or null when the label is not a shard label. */
export const parseShardLabel = (label) => {
  const match = SHARD_LABEL_PATTERN.exec(String(label ?? ""));
  if (!match) {
    return null;
  }
  return { shardNumber: Number(match[1]), shardCount: Number(match[2]) };
};

// The execute stages, each with the plan name the planner emits, the stage cost
// key the calibration uses, and the artifact suffix the execute job writes
// under. Keeping the three together is the point: they used to be restated
// independently in the planner, the calibration model, and the observer.
export const EXECUTE_STAGES = Object.freeze([
  Object.freeze({
    stage: "v1Ms",
    planName: "v1",
    artifactSuffix: "v1",
    otelServiceSuffix: "v1",
  }),
  Object.freeze({
    stage: "v2SyncMs",
    planName: "v2-sync-default",
    // Lossy on purpose, and long-standing: sync artifacts are written under
    // `v2`, so `resolveTraceJobIdentity` cannot distinguish sync from hybrid
    // from an artifact path and needs the run's execution profile to decide.
    artifactSuffix: "v2",
    otelServiceSuffix: "v2-sync",
  }),
  Object.freeze({
    stage: "v2HybridMs",
    planName: "v2-hybrid-computed",
    artifactSuffix: "v2-hybrid-computed",
    otelServiceSuffix: "v2-hybrid",
  }),
]);

export const SEED_STAGE = Object.freeze({
  stage: "seedJobMs",
  jobPrefix: "Prepare perf seed DB",
});

const EXECUTE_JOB_PREFIX = "Run perf cases";

/** The GitHub job title for an execute stage's shard. */
export const formatJobName = (planName, shardLabel) =>
  `${EXECUTE_JOB_PREFIX} (${planName}-${shardLabel})`;

/** The GitHub job title for a seed shard. */
export const formatSeedJobName = (shardLabel) =>
  `${SEED_STAGE.jobPrefix} (${shardLabel})`;

/**
 * `{ stage, shardLabel }` for a seed or execute job title, else null.
 * The inverse of formatJobName / formatSeedJobName.
 */
export const parseJobName = (jobName) => {
  const name = String(jobName ?? "");

  const seed = new RegExp(
    `^${SEED_STAGE.jobPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((shard-\\d+-of-\\d+)\\)$`,
  ).exec(name);
  if (seed) {
    return { stage: SEED_STAGE.stage, shardLabel: seed[1] };
  }

  for (const { stage, planName } of EXECUTE_STAGES) {
    const match = new RegExp(
      `^${EXECUTE_JOB_PREFIX} \\(${planName}-(shard-\\d+-of-\\d+)\\)$`,
    ).exec(name);
    if (match) {
      return { stage, shardLabel: match[1] };
    }
  }

  return null;
};
