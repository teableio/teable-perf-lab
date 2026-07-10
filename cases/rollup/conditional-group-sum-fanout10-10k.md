---
owner: backend-v2
tags: [rollup, sum, number, 10k, v1-v2]
enabled: true
---

# rollup/conditional-group-sum-fanout10-10k

## Goal

Measure adding a conditional numeric sum over 10 matching source rows for every row of a 10k host.

## Seed Phase

Use the shared grouped fixture; each source group contains 10 deterministic amounts.

## Execute Phase

Match by dynamic group, apply `sum({values})`, and verify the exact sum across all 10k host rows.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Exercises numeric aggregation with 100,000 total matched values.
