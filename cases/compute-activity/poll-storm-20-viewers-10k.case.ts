import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "compute-activity/poll-storm-20-viewers-10k",
  title: "20 viewers polling one table's compute activity at once",
  runner: "compute-activity-poll",
  routingEvidence: "not-applicable",
  timeoutMs: 600_000,
  watchdogMs: 180_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-compute-activity-poll-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    formulaFieldCount: 5,
    warmupRounds: 20,
    viewers: 20,
    rounds: 20,
    thinkTimeMs: 0,
    budgetMs: 120_000,
    threshold: {
      metric: "pollP50Ms",
      maxMs: 2_000,
    },
  },
});
