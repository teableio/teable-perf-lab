---
owner: backend-v2
tags:
  [record-read, get-records, filter, number, selective, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-number-greater-half

## Goal

Measure a selective numeric filter over a 10,000-row, 50-field projected read.

## Seed Phase

Reuse the shared record-read fixture where stored field `A` equals the row
number from 1 through 10,000 and all projected formula and lookup values are
ready.

## Execute Phase

Run the unqueried paged baseline, then repeat the scan with `A isGreater 5000`.
The runner still issues the full deterministic ten-page request sequence.

## Primary Metric

`getRecordsQueryOverheadMs`, the non-negative queried-minus-baseline duration.
Initial guardrail: 8,000 ms.

## Notes

Verification requires exactly 5,000 distinct rows, proves every row has
`A > 5000`, checks all 50 values, and asserts V1/V2 routing per page.
