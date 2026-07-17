---
owner: backend-v2
tags: [record-read, get-records, sort, formula, computed, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-sort-formula-descending

## Goal

Measure sorting a wide result set by a computed numeric value.

## Seed Phase

Reuse the shared fixture where `Formula 5 = A*B + C` is fully computed.

## Execute Phase

Run the baseline, then order by `Formula 5 desc` and stored tie-breaker `A asc`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual computed-sort paged-scan duration.
Initial guardrail: 8,000 ms. Baseline duration and signed delta remain
diagnostics.

## Notes

Verification requires all 10,000 rows in full tuple order, complete 50-field
value correctness, and matched V1/V2 routing.
