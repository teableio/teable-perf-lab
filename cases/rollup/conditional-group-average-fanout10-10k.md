---
owner: backend-v2
tags: [rollup, average, number, 10k, v1-v2]
enabled: true
---

# rollup/conditional-group-average-fanout10-10k

## Goal

Measure adding a conditional numeric average over 10 matching source rows for every row of a 10k host.

## Seed Phase

Use the shared grouped fixture with deterministic numeric values and fanout 10.

## Execute Phase

Match by dynamic group, apply `average({values})`, and verify every calculated average.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Separates average aggregation from the sum and count execution paths.
