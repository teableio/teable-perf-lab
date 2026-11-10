import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/delete-stream-10k",
  title: "Delete a 10k-row table through the grid selection delete stream",
  runner: "record-delete-stream",
  seedAffinity: "record-replay/10k",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 10_000,
    batchSize: 1_000,
    tableNamePrefix: "perf-record-delete-stream-10k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteStream10kMs",
      // Tightened from a loose first guard now that local runs land low (v1
      // ~1.5s / v2 ~2.7s for the stream itself). 60s keeps ~22x over local worst
      // case for CI noise and isolated-DB cold start, while still catching a real
      // O(n) blow-up. Refine once CI history exists.
      maxMs: 60_000,
    },
  },
});
