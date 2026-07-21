import { definePerfCase } from "../../framework/types";
import { recordRead100k50FieldsBaseConfig } from "./100k-50fields.shared";

export default definePerfCase({
  id: "record-read/100k-50fields-filter-number-sort-descending",
  title: "Filter and descending-sort a 100k 50-field record read",
  runner: "record-read",
  timeoutMs: 3_600_000,
  watchdogMs: 900_000,
  config: {
    ...recordRead100k50FieldsBaseConfig,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [{ fieldName: "A", operator: "isGreater", value: 50_000 }],
      },
      orderBy: [{ fieldName: "A", order: "desc" }],
      expectedRowCount: 50_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 120_000 },
  },
});
