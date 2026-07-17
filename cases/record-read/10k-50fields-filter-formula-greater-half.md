---
owner: backend-v2
tags:
  [record-read, get-records, filter, formula, computed, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-formula-greater-half

## Goal

Measure a selective numeric predicate on a computed formula in a wide read.

## Seed Phase

Reuse the shared 10,000-row, 50-field fixture where
`Formula 1 = A + B + C` is ready for every row.

## Execute Phase

Run the unqueried baseline, then query `Formula 1 isGreater 5050`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual queried paged-scan duration. Initial
guardrail: 8,000 ms. Baseline duration and signed delta remain diagnostics.

## Notes

Verification requires exactly 5,004 distinct rows, proves the formula
predicate, checks all 50 projected values, and asserts routing on every page.
