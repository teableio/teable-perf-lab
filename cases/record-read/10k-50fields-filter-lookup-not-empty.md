---
owner: backend-v2
tags: [record-read, get-records, filter, lookup, computed, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-lookup-not-empty

## Goal

Measure filtering on a computed conditional lookup column.

## Seed Phase

Reuse the shared fixture where every host row has one ready `Lookup Value 1`.

## Execute Phase

Run the baseline, then query `Lookup Value 1 isNotEmpty`.

## Primary Metric

`getRecordsQueryPagedScanMs`, the actual lookup-filter paged-scan duration.
Initial guardrail: 8,000 ms. Baseline duration and signed delta remain
diagnostics.

## Notes

The query must return exactly 10,000 distinct rows. The runner proves every
lookup array is non-empty, checks all 50 values, and asserts routing per page.
