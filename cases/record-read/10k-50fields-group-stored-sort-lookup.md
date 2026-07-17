---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    group-by,
    sort,
    lookup,
    computed,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-group-stored-sort-lookup

## Goal

Measure stored grouping with computed lookup ordering inside each group.

## Seed Phase

Reuse the shared fixture where stored `C` has seven values and every lookup
result is deterministic and unique.

## Execute Phase

Run the baseline, then group by `C asc` and order by
`Lookup Value 1 desc`, `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual grouped lookup-sort paged-scan
duration. Initial guardrail: 8,000 ms. Baseline duration and signed delta
remain diagnostics.

## Notes

All 10,000 rows must obey the full group/sort tuple and preserve complete value
and routing correctness.
