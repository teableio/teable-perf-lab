---
owner: backend-v2
tags: [lookup, text, 10k, 50k, v1-v2, conditional, fanout, scale-curve]
enabled: true
---

# lookup/conditional-group-text-fanout50-10k

## Goal

Measure the middle of the conditional text-lookup scale curve by returning 50 matching values for every row of a 10k host.

## Seed Phase

Create a 50k-row source and a 10k-row host. The source has 1,000 groups with 50 text rows per group; the host deterministically references those groups.

## Execute Phase

Match `A Group` to the current row's `Lookup Group`, sort by `A Amount`, create a conditional lookup that returns all 50 `A Text` values, and verify every host result.

The workload contains 500,000 group-match pairs and returns 500,000 text values across the host table.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Compared with fanout 10, host rows and the condition stay fixed while the source rows and returned lookup-array width increase fivefold.
