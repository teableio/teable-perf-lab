---
owner: backend-v2
tags: [rollup, sum, number, 10k, v1-v2, multi-filter, scale-curve]
enabled: true
---

# rollup/conditional-group-active-sum-fanout10-10k

## Goal

Measure the baseline of a customer-like conditional amount sum on a 10k-row host, using dynamic group matching plus an active-state condition.

## Seed Phase

Use the shared 10k source/10k host fixture. The source has 1,000 groups with 10 rows per group; five rows in each group are active.

## Execute Phase

Match the current host group, require `A Active=true`, apply `sum({values})` to `A Amount`, and verify the exact sum across all 10,000 host rows.

The workload contains 100,000 group-match pairs. The active filter retains 50,000 values for aggregation.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

This is the first point in the fanout 10/50/100 scale curve. The host size, filter shape, aggregation, and verification stay fixed across the curve.
