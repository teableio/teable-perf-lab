---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    group-by,
    sort,
    formula,
    computed,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-group-stored-sort-formula

## Goal

Measure stored-field grouping with computed ordering inside each group.

## Seed Phase

Reuse the shared fixture where stored `C` has seven values and `Formula 4` is
fully computed.

## Execute Phase

Run the baseline, then group by `C asc` and order by `Formula 4 desc`, `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual grouped computed-sort paged-scan
duration. Initial guardrail: 8,000 ms. Baseline duration and signed delta
remain diagnostics.

## Notes

All 10,000 rows must follow the full group/sort tuple and retain correct values
and routing. The group key remains stored for cross-engine stability.
