import type { ConditionalQueryBaseCaseConfig } from "../framework/types";

export const groupedConditionalQueryBase = {
  baseId: "seed-base",
  sourceTableNamePrefix: "perf-conditional-query-source-10k",
  hostTableNamePrefix: "perf-conditional-query-host-10k",
  sourceRecordCount: 10_000,
  hostRecordCount: 10_000,
  groupCount: 1_000,
  batchSize: 1_000,
  generator: {
    type: "grouped-fanout",
    groupPrefix: "A-Group",
    sourceTextPrefix: "A-Value",
    hostKeyPrefix: "B-Key",
    permutation: { multiplier: 73, offset: 19 },
  },
  verify: {
    sampleRows: [0, 4_999, 9_999],
    timeoutMs: 180_000,
    pollIntervalMs: 500,
    fullScanPageSize: 1_000,
  },
} satisfies Omit<ConditionalQueryBaseCaseConfig, "field">;

export const groupedConditionalQueryFanout100Base = {
  ...groupedConditionalQueryBase,
  sourceTableNamePrefix: "perf-conditional-query-source-100k",
  hostTableNamePrefix: "perf-conditional-query-host-10k-fanout100",
  sourceRecordCount: 100_000,
  verify: {
    ...groupedConditionalQueryBase.verify,
    timeoutMs: 600_000,
  },
} satisfies Omit<ConditionalQueryBaseCaseConfig, "field">;

export const groupedConditionalQueryFanout100Host30kBase = {
  ...groupedConditionalQueryFanout100Base,
  hostTableNamePrefix: "perf-conditional-query-host-30k-fanout100",
  hostRecordCount: 30_000,
} satisfies Omit<ConditionalQueryBaseCaseConfig, "field">;
