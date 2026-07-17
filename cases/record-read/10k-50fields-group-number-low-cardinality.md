---
owner: backend-v2
tags:
  [
    record-read,
    get-records,
    group-by,
    number,
    low-cardinality,
    10k,
    50fields,
    v1-v2,
  ]
enabled: true
---

# record-read/10k-50fields-group-number-low-cardinality

## Goal

Measure grouping a 10,000-row, 50-field read by a seven-value stored number
field.

## Seed Phase

Reuse the shared record-read fixture where `C` cycles deterministically from 1
through 7 while formulas and conditional lookups remain in the projection.

## Execute Phase

Run the unqueried baseline, then scan ten pages with `groupBy C asc`.

## Primary Metric

`getRecordsQueryOverheadMs`, group query duration minus baseline duration,
clamped at zero. Initial guardrail: 8,000 ms.

## Notes

Verification requires all 10,000 rows once, nondecreasing group keys, correct
50-field values, and matched V1/V2 routing.
