---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    filter,
    sort,
    group-by,
    selective,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-filter-sort-groupby-selective

## Goal

Measure the full filter, sort, and groupBy path with a selective predicate and
low-cardinality grouping.

## Seed Phase

Reuse the shared fixture where `A` is unique row number and `C` cycles 1–7;
the 50-field projection still includes formulas and conditional lookups.

## Execute Phase

Run the baseline, then query `A isGreater 5000`, group by `C asc`, and order
within groups by `A desc`.

## Primary Metric

`getRecordsQueryOverheadMs`, the non-negative query overhead above the warmed
baseline. Initial guardrail: 8,000 ms.

## Notes

This differs from the existing match-all/unique-text composite case. It must
return exactly 5,000 rows ordered by group then sort, with complete value and
routing verification.
