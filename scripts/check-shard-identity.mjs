// Shard/stage identity guardrail.
//
// The identity is a string that crosses CI: the planner formats it, GitHub puts
// it in a job title, the observer parses it back. Encode and decode used to live
// in different modules — the label was formatted in six places and parsed by
// four regexes that named the stages a fifth time — so a format change could
// land on one side only and the observer would silently stop recognising jobs.
//
// Now that both directions are in one module, the round trip is a property, so
// assert it rather than hope.

import assert from "node:assert/strict";
import {
  EXECUTE_STAGES,
  SEED_STAGE,
  formatJobName,
  formatSeedJobName,
  formatShardLabel,
  parseJobName,
  parseShardLabel,
} from "./shard-identity.mjs";

// Label format is the one CI and the seed cache key already depend on.
assert.equal(formatShardLabel(0, 8), "shard-1-of-8");
assert.equal(formatShardLabel(7, 8), "shard-8-of-8");
assert.deepEqual(parseShardLabel("shard-3-of-8"), {
  shardNumber: 3,
  shardCount: 8,
});
assert.equal(parseShardLabel("slot-3"), null);
assert.equal(parseShardLabel("targeted"), null);
assert.equal(parseShardLabel(undefined), null);

// Round trip: every execute stage, every shard of a realistic run.
for (const { stage, planName } of EXECUTE_STAGES) {
  for (let index = 0; index < 8; index += 1) {
    const shardLabel = formatShardLabel(index, 8);
    const parsed = parseJobName(formatJobName(planName, shardLabel));
    assert.deepEqual(
      parsed,
      { stage, shardLabel },
      `${planName} ${shardLabel} must round trip`,
    );
  }
}

// Seed jobs round trip too.
for (let index = 0; index < 8; index += 1) {
  const shardLabel = formatShardLabel(index, 8);
  assert.deepEqual(parseJobName(formatSeedJobName(shardLabel)), {
    stage: SEED_STAGE.stage,
    shardLabel,
  });
}

// The exact job titles the workflow produces today must keep resolving, so a
// refactor of the formatter cannot quietly orphan historical runs.
assert.deepEqual(parseJobName("Run perf cases (v1-shard-1-of-8)"), {
  stage: "v1Ms",
  shardLabel: "shard-1-of-8",
});
assert.deepEqual(
  parseJobName("Run perf cases (v2-sync-default-shard-6-of-8)"),
  { stage: "v2SyncMs", shardLabel: "shard-6-of-8" },
);
assert.deepEqual(
  parseJobName("Run perf cases (v2-hybrid-computed-shard-2-of-8)"),
  { stage: "v2HybridMs", shardLabel: "shard-2-of-8" },
);
assert.deepEqual(parseJobName("Prepare perf seed DB (shard-4-of-8)"), {
  stage: "seedJobMs",
  shardLabel: "shard-4-of-8",
});

// Non-shard jobs must not resolve to a stage.
assert.equal(parseJobName("Report perf results"), null);
assert.equal(parseJobName("Resolve workflow inputs"), null);
assert.equal(parseJobName("Prepare perf seed DB"), null);
// The unsplit v2 title is handled by the observer with the run's execution
// profile, not here, because the title alone cannot say sync from hybrid.
assert.equal(parseJobName("Run perf cases (v2-shard-1-of-8)"), null);

// Stage keys must match the calibration's cost keys, which is the coupling that
// made "stage" mean five different things across the scripts layer.
const { STAGE_COST_KEYS } = await import("./stage-aware-shard-model.mjs");
for (const { stage } of EXECUTE_STAGES) {
  assert.ok(
    STAGE_COST_KEYS.includes(stage),
    `execute stage ${stage} must be a stage cost key`,
  );
}

console.log(
  `Shard identity checks ok (${EXECUTE_STAGES.length} execute stages round trip over 8 shards).`,
);
