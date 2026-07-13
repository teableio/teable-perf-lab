---
owner: backend-v2
tags:
  [
    lookup,
    text,
    10k,
    100k,
    v1-v2,
    conditional,
    multi-filter,
    realistic,
    scale-curve,
  ]
enabled: true
---

# lookup/conditional-group-active-text-fanout100-10k

## Goal

Measure a high-volume multi-condition text lookup where half of 100 group matches remain active for every row of a 10k host.

## Seed Phase

Create a 100k-row source and a 10k-row host. Each of 1,000 groups contains 100 source rows, with 50 deterministically marked active.

## Execute Phase

Match the current host group, require `A Active=true`, sort by `A Amount`, return the retained `A Text` values, and verify every host result.

The workload evaluates 1,000,000 group-match pairs and returns 500,000 text values after the active filter.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Compare this case with the unfiltered fanout-100 lookup to separate candidate matching from the cost of materializing twice as many result values.
