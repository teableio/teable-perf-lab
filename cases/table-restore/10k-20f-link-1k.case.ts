import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-restore/10k-20f-link-1k",
  title:
    "Restore a 10k-record 20-field table owning a populated link field from trash",
  runner: "table-restore-link",
  timeoutMs: 1_800_000,
  // V1 only: the deleteSetup and restoreTableVerify steps fire a large request
  // burst (~170 verify reads across samples) whose server spans overflow the
  // OTel export queue and 404 in Jaeger. On V1 (won't-fix engine) we don't debug
  // those traces, so polling each missing one to timeout is pure wasted CI
  // wall-clock — narrow V1 capture to the measured restore op plus one
  // before/after sample (~210 -> ~30 traces, ~45s -> ~0 missing-trace polling).
  // V2 does NOT drop these (PR #2248 protects route roots), so it has no
  // engine-suffixed key and keeps capturing every trace for debugging.
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN_V1:
      "^restoreTable-sample-\\d+$,^deleteSetup-sample-01$,^restoreTableVerify-sample-01$",
  },
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-table-restore-link-10k",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-table-restore-link",
    },
    samples: 5,
    link: {
      fieldName: "Ref Link",
      foreignTable: {
        rowCount: 1_000,
        batchSize: 1_000,
        keyPrefix: "RESTORE-FK",
      },
      permutation: {
        multiplier: 7,
        offset: 3,
      },
    },
    threshold: {
      metric: "restoreTableP95Ms",
      // Restore is metadata-only today even with 10k populated link cells;
      // this sentinel fires if restore ever gains record-dependent work
      // (link re-attachment, computed-field recompute, ...). Local v1/v2
      // verification on 2026-06-12 measured p95 at 36.29 ms / 26.01 ms.
      maxMs: 1_000,
    },
  },
});
