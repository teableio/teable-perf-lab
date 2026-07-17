import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-sort-groupby-overhead",
  title:
    "Compare 10k 50-field record reads with and without filter, sort and groupBy",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          {
            fieldName: "Text 1",
            operator: "isNotEmpty",
            value: null,
          },
        ],
      },
      orderBy: [{ fieldName: "A", order: "asc" }],
      groupBy: [{ fieldName: "Text 2", order: "asc" }],
      expectedRowCount: 10_000,
    },
    threshold: {
      metric: "getRecordsFilterSortGroupByOverheadMs",
      // Calibrated 2026-06-22 from 85 CI runs (v1+v2, Apr-Jun 2026): p95 ~2210ms,
      // worst ~3068ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 30_000).
      maxMs: 8_000,
    },
  },
});
