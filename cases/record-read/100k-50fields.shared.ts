import type { RecordReadCaseConfig } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export const recordRead100k50FieldsBaseConfig = {
  ...baseCase.config,
  sourceTableNamePrefix: "perf-record-read-source-100k-50fields",
  tableNamePrefix: "perf-record-read-host-100k-50fields",
  rowCount: 100_000,
  verify: {
    sampleRows: [0, 999, 49_999, 99_999],
    timeoutMs: 900_000,
    pollIntervalMs: 1_000,
    fullScanPageSize: 1_000,
  },
} satisfies Omit<RecordReadCaseConfig, "queryVariant" | "threshold">;
