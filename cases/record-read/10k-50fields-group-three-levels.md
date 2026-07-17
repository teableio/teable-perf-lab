---
owner: backend-v2
tags: [record-read, get-records, group-by, multi-group, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-group-three-levels

## Goal

Measure a three-level grouped read across low-, medium-, and high-cardinality
stored fields.

## Seed Phase

Reuse the shared 10k/50-field fixture where `C`, `B`, and `A` provide seven,
one hundred, and ten thousand deterministic values respectively.

## Execute Phase

Run the baseline, then scan with group levels `C asc`, `B desc`, and `A asc`.

## Primary Metric

`getRecordsQueryOverheadMs`, the non-negative grouped-minus-baseline duration.
Initial guardrail: 8,000 ms.

## Notes

The final unique group key stabilizes page boundaries. The runner checks the
complete group tuple, exact row set, all 50 values, and routing on each page.
