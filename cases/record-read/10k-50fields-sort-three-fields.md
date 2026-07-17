---
owner: backend-v2
tags: [record-read, get-records, sort, multi-sort, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-sort-three-fields

## Goal

Measure a three-column sort over a wide 10,000-row record read.

## Seed Phase

Reuse the shared fixture where `C` cycles 1–7, `B` cycles 1–100, and unique
field `A` equals the row number.

## Execute Phase

Run the unqueried baseline, then scan with `C asc`, `B desc`, and `A asc`.

## Primary Metric

`getRecordsQueryOverheadMs`, the non-negative delta from the warmed baseline.
Initial guardrail: 8,000 ms.

## Notes

The unique final key makes paging deterministic. Verification checks the full
sort tuple, 10,000 unique rows, all projected values, and every route header.
