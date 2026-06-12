import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-restore/10k-20f-link-1k",
  title:
    "Restore a 10k-record 20-field table owning a populated link field from trash",
  runner: "table-restore-link",
  timeoutMs: 1_800_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-table-restore-link-10k",
    generator: {
      ...undoRedo10kBaseConfig.generator,
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
