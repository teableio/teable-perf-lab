---
owner: backend-v2
tags:
  [rollup, sum, number, 10k, 100k, v1-v2, multi-filter, realistic, scale-curve]
enabled: true
---

# rollup/conditional-group-active-sum-fanout100-10k

## Goal

Measure a customer-like high-computation conditional amount sum on 110k total records without reproducing the full 120k-plus customer table.

## Seed Phase

Create a 100k-row source and a 10k-row host. The source has 1,000 groups with 100 rows per group; 50 rows in each group are active.

## Execute Phase

Match the current host group, require `A Active=true`, apply `sum({values})` to all retained `A Amount` values, and verify every host result.

The workload contains 1,000,000 group-match pairs. The active filter retains 500,000 values for aggregation.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

This is the high point in the fanout 10/50/100 curve. The table pair has 110,000 records in total, close to the reported customer scale while keeping the workload locally convergent.
