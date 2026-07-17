---
owner: backend-v2
tags: [record-read, get-records, filter, sort, number, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-number-sort-descending

## Goal

Measure the common composed path of a selective numeric filter plus descending
sort on a 10,000-row wide read.

## Seed Phase

Reuse the shared record-read fixture where `A` is unique and equals row number.

## Execute Phase

Run the unqueried baseline, then query `A isGreater 5000` with `A desc`.

## Primary Metric

`getRecordsQueryOverheadMs`, the queried-minus-baseline duration clamped at
zero. Initial guardrail: 8,000 ms.

## Notes

Verification requires exactly 5,000 rows ordered from `A=10000` to `A=5001`,
with no duplicates, correct 50-field values, and matched routes.
