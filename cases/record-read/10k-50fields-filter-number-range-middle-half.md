---
owner: backend-v2
tags: [record-read, get-records, filter, range, number, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-number-range-middle-half

## Goal

Measure an AND range filter with two predicates on the same numeric field.

## Seed Phase

Reuse the ready 10,000-row, 50-projected-field record-read fixture where `A`
is the deterministic row number.

## Execute Phase

Run the unqueried baseline, then query `A isGreater 2500` AND
`A isLessEqual 7500` through ten 1,000-row page offsets.

## Primary Metric

`getRecordsQueryOverheadMs`, clamped at zero after subtracting the warmed
baseline. Initial guardrail: 8,000 ms.

## Notes

The exact expected result is 5,000 distinct rows. Both predicates and every
projected field value are checked after the measured read.
