---
owner: backend-v2
tags:
  [
    lookup,
    text,
    10k,
    50k,
    v1-v2,
    conditional,
    multi-filter,
    fanout,
    scale-curve,
  ]
enabled: true
---

# lookup/conditional-group-active-text-fanout50-10k

## Goal

Measure the middle of a multi-condition text-lookup scale curve where half of 50 group matches remain active for every row of a 10k host.

## Seed Phase

Create a 50k-row source and a 10k-row host. Each of 1,000 groups contains 50 source rows, with 25 deterministically marked active.

## Execute Phase

Match the current host group, require `A Active=true`, sort by `A Amount`, return the retained `A Text` values, and verify every host result.

The workload evaluates 500,000 group-match pairs and returns 250,000 text values after the active filter.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Compare this case with the unfiltered fanout-50 lookup to separate candidate matching from result-array materialization.
