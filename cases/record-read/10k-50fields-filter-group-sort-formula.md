---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    filter,
    group-by,
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

# record-read/10k-50fields-filter-group-sort-formula

## Goal

Measure the full computed-filter, stored-group, and computed-sort path.

## Seed Phase

Reuse the shared fixture where `Formula 2 = A*C + B` and stored `C` are ready.

## Execute Phase

Run the baseline, then query `Formula 2 isGreater 15000`, group by `C asc`, and
order by `Formula 2 desc`, `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual composite query paged-scan duration.
Initial guardrail: 8,000 ms. Baseline duration and signed delta remain
diagnostics.

## Notes

Verification requires exactly 5,173 distinct matching rows in the full
group/sort order, with all projected values and route headers correct.
