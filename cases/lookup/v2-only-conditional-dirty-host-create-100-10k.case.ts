import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/v2-only-conditional-dirty-host-create-100-10k",
  title: "V2-only: create 100 dirty conditional-lookup hosts beside 10k rows",
  runner: "conditional-lookup-record-create",
  timeoutMs: 300_000,
  watchdogMs: 60_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-conditional-lookup-source-10k",
    hostTableNamePrefix: "perf-conditional-lookup-host-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    generator: {
      type: "permuted-unique-key-sequence",
      sourceKeyPrefix: "A-Key",
      hostKeyPrefix: "B-Key",
      sourceValuePrefix: "A-Value",
      permutation: {
        multiplier: 73,
        offset: 19,
      },
    },
    lookup: {
      name: "Matched A Value before dirty create",
      limit: 1,
    },
    mutation: {
      recordCount: 100,
      sourceStartOffset: 0,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      dirtySampleRows: [0, 49, 99],
      timeoutMs: 60_000,
      pollIntervalMs: 200,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "conditionalLookupRecordCreateReadyMs",
      // Initial guardrail: the primary window creates only 100 dirty hosts but
      // also proves the complete 10,100-row final state. Tighten after CI history.
      maxMs: 10_000,
    },
  },
});
