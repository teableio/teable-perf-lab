---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    filter,
    sort,
    formula,
    computed,
    selective,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-filter-sort-formula-selective

## Goal

Measure selective formula filtering composed with formula sorting.

## Seed Phase

Reuse the shared fixture where `Formula 2 = A*C + B` is ready.

## Execute Phase

Run the baseline, then query `Formula 2 isGreater 15000`, ordered by
`Formula 2 asc` and `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual queried paged-scan duration. Initial
guardrail: 8,000 ms. Baseline duration and signed delta remain diagnostics.

## Notes

Verification requires exactly 5,173 rows satisfying the computed predicate and
the full order tuple, plus all projected values and route headers.
