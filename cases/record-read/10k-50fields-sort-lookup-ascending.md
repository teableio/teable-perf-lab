---
owner: backend-v2
tags: [record-read, get-records, sort, lookup, computed, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-sort-lookup-ascending

## Goal

Measure sorting by a computed lookup text value.

## Seed Phase

Reuse the shared fixture whose bijective source permutation makes every
`Lookup Value 1` result unique.

## Execute Phase

Run the baseline, then order by `Lookup Value 1 asc` and `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual lookup-sort paged-scan duration.
Initial guardrail: 8,000 ms. Baseline duration and signed delta remain
diagnostics.

## Notes

Verification requires all 10,000 rows in displayed lookup order, all projected
values correct, and matched V1/V2 routing on every request.
