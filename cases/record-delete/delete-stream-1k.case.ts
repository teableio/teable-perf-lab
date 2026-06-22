import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/delete-stream-1k",
  title: "Delete a 1k-row table through the grid selection delete stream",
  runner: "record-delete-stream",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-stream-1k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteStream1kMs",
      // Tightened from a loose first guard to match the sync delete-1k sibling
      // (also 30s) now that local runs land sub-second (v1 ~0.26s / v2 ~0.41s
      // for the stream itself). Still ~70x over local worst case for CI noise;
      // refine again once CI history exists.
      maxMs: 30_000,
    },
  },
});
