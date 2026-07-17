---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    search,
    visible-rows,
    lookup,
    computed,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-search-lookup-visible-row

## Goal

Measure field-scoped visible-row search on a computed lookup value.

## Seed Phase

Reuse the shared fixture. Host row 42 deterministically resolves lookup text
`Read-Value-1-03013`.

## Execute Phase

Run the baseline, then search `Lookup Value 1` for `1-03013` with
`hideNotMatchRow=true`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual lookup-search paged-scan duration.
Initial guardrail: 8,000 ms. Baseline duration and signed delta remain
diagnostics.

## Notes

Verification requires exactly host row 42 with all 50 values correct and
rejects highlight-only behavior that leaves unmatched rows visible.
