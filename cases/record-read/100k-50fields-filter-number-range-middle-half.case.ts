import { definePerfCase } from "../../framework/types";
import { recordRead100k50FieldsBaseConfig } from "./100k-50fields.shared";

export default definePerfCase({
  id: "record-read/100k-50fields-filter-number-range-middle-half",
  title: "Filter a 100k 50-field record read to a middle numeric range",
  runner: "record-read",
  timeoutMs: 3_600_000,
  watchdogMs: 1_200_000,
  config: {
    ...recordRead100k50FieldsBaseConfig,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          { fieldName: "A", operator: "isGreater", value: 25_000 },
          { fieldName: "A", operator: "isLessEqual", value: 75_000 },
        ],
      },
      expectedRowCount: 50_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 120_000 },
  },
});
