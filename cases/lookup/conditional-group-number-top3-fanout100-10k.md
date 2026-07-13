---
owner: backend-v2
tags:
  [
    lookup,
    number,
    10k,
    100k,
    v1-v2,
    conditional,
    sort,
    top3,
    realistic,
    scale-curve,
  ]
enabled: true
---

# lookup/conditional-group-number-top3-fanout100-10k

## Goal

Measure a high-volume conditional top-three lookup where each row of a 10k host sorts 100 candidates but returns only three numbers.

## Seed Phase

Create a 100k-row source and a 10k-row host with 1,000 deterministic groups and 100 numbered source rows per group.

## Execute Phase

Match the current host group, sort matching rows by `A Amount` descending, return the top three amounts, and verify every host result.

The workload evaluates and sorts 1,000,000 group-match pairs but returns only 30,000 values across the host table.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Compare this with the fanout-100 text cases: all three evaluate the same candidate count, while result width changes from three to 50 or 100 values per host row.
