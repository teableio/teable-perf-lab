---
owner: backend-v2
tags:
  [lookup, text, 10k, 100k, v1-v2, conditional, fanout, realistic, scale-curve]
enabled: true
---

# lookup/conditional-group-text-fanout100-10k

## Goal

Measure a customer-like high-volume conditional text lookup that returns 100 matching values for every row of a 10k host.

## Seed Phase

Create a 100k-row source and a 10k-row host. The source has 1,000 groups with 100 text rows per group; the host deterministically references those groups.

## Execute Phase

Match `A Group` to the current row's `B Lookup Group`, sort by `A Amount`, create a conditional lookup that returns all 100 `A Text` values, and verify every host result.

The workload contains 1,000,000 group-match pairs and returns 1,000,000 text values across the host table.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

This is the high point of the fanout 10/50/100 result-width curve. The table pair has 110,000 records, while the 10k host materializes one million lookup values.
