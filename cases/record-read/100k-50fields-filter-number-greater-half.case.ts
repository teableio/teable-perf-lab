import { definePerfCase } from "../../framework/types";
import { recordRead100k50FieldsBaseConfig } from "./100k-50fields.shared";

export default definePerfCase({
  id: "record-read/100k-50fields-filter-number-greater-half",
  title: "Filter a 100k 50-field record read to the upper numeric half",
  runner: "record-read",
  timeoutMs: 3_600_000,
  watchdogMs: 1_200_000,
  config: {
    ...recordRead100k50FieldsBaseConfig,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [{ fieldName: "A", operator: "isGreater", value: 50_000 }],
      },
      expectedRowCount: 50_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 120_000 },
  },
});
