---
owner: backend-v2
tags: [rollup, sum, number, 10k, 50k, v1-v2, multi-filter, scale-curve]
enabled: true
---

# rollup/conditional-group-active-sum-fanout50-10k

## Goal

Measure the middle of the conditional amount-sum scale curve by increasing source fanout to 50 while keeping the 10k host and field configuration unchanged.

## Seed Phase

Create a 50k-row source and a 10k-row host. The source has 1,000 groups with 50 rows per group; 25 rows in each group are active.

## Execute Phase

Match the current host group, require `A Active=true`, apply `sum({values})` to all retained `A Amount` values, and verify every host result.

The workload contains 500,000 group-match pairs. The active filter retains 250,000 values for aggregation.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Compared with fanout 10, only source rows per group and the matching field limit increase. Host rows, conditions, aggregation, and verification remain fixed.
