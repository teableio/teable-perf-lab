---
owner: backend-v2
tags: [lookup, number, 10k, 50k, v1-v2, conditional, sort, top3, scale-curve]
enabled: true
---

# lookup/conditional-group-number-top3-fanout50-10k

## Goal

Measure conditional top-three lookup cost when each row of a 10k host sorts 50 candidates but still returns only three numbers.

## Seed Phase

Create a 50k-row source and a 10k-row host with 1,000 deterministic groups and 50 numbered source rows per group.

## Execute Phase

Match the current host group, sort matching rows by `A Amount` descending, return the top three amounts, and verify every host result.

The workload evaluates and sorts 500,000 group-match pairs but returns only 30,000 values across the host table.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

The fixed three-value result isolates candidate matching and sorting from lookup result-array width.
