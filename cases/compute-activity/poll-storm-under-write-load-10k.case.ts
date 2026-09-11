import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "compute-activity/poll-storm-under-write-load-10k",
  title: "Twenty viewers polling while writes drive computed work",
  runner: "compute-activity-poll",
  routingEvidence: "not-applicable",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-compute-activity-poll-writes-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    formulaFieldCount: 5,
    warmupRounds: 20,
    viewers: 20,
    rounds: 20,
    thinkTimeMs: 0,
    budgetMs: 180_000,
    writeLoad: {
      writers: 2,
      rounds: 20,
      thinkTimeMs: 0,
      recordsPerWrite: 200,
    },
    threshold: {
      metric: "pollP50Ms",
      maxMs: 5_000,
    },
  },
});
