import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-delete/10k-20f-link-detach",
  title:
    "Archive a table that a 10k-record 20-field table still links to (detachLink)",
  runner: "table-delete-link",
  timeoutMs: 1_800_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-table-delete-link-10k",
    generator: {
      ...undoRedo10kBaseConfig.generator,
      source: "perf-lab-table-delete-link",
    },
    // v1 soft delete destructively converts the surviving link field, so the
    // fixture cannot be reused after a v1 run; keep the sample count small to
    // bound the per-run reseeding cost (3 x (10k main + 1k foreign) records).
    samples: 3,
    link: {
      fieldName: "Ref Link",
      foreignTable: {
        rowCount: 1_000,
        batchSize: 1_000,
        keyPrefix: "DELETE-FK",
      },
      permutation: {
        multiplier: 7,
        offset: 3,
      },
    },
    threshold: {
      metric: "deleteTableDetachLinkP95Ms",
      // v1 pays detachLink: a field convert over the surviving table's 10k
      // link cells inside the delete request (expected seconds, O(rowCount)).
      // v2 soft delete skips that side effect (expected tens of ms).
      maxMs: 60_000,
    },
  },
});
