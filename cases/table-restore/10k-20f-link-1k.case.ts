import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-restore/10k-20f-link-1k",
  title:
    "Restore a 10k-record 20-field table owning a populated link field from trash",
  runner: "table-restore-link",
  timeoutMs: 1_800_000,
  // Trace snapshots exist to debug the *measured* operation (restoreTable). The
  // deleteSetup and restoreTableVerify steps fire a large request burst (~170
  // verify reads across samples) whose server spans overflow the OTel export
  // queue and 404 in Jaeger; on V1 that loss is won't-fix, so polling those
  // traces to timeout is pure wasted CI wall-clock. Capture every restore-op
  // trace plus one before/after sample for V2 debugging context, and skip the
  // rest. Cuts selected traces ~210 -> ~30 and missing-trace polling ~45s -> ~5s.
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN:
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
