---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    filter,
    range,
    formula,
    computed,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-filter-formula-range-middle

## Goal

Measure an AND range filter on a computed numeric expression.

## Seed Phase

Reuse the shared fixture where `Formula 4 = 3*A + 5*B + 7*C` is ready.

## Execute Phase

Run the baseline, then query `Formula 4 isGreater 8000` AND
`Formula 4 isLessEqual 23000`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual queried paged-scan duration. Initial
guardrail: 8,000 ms. Baseline duration and signed delta remain diagnostics.

## Notes

The deterministic range contains exactly 5,000 distinct rows. Both predicates
and every projected cell are checked after measurement.
