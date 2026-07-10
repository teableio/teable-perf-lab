---
owner: backend-v2
tags: [lookup, number, 10k, v1-v2, sort-limit]
enabled: true
---

# lookup/conditional-group-number-top3-10k

## Goal

Measure adding a conditional number lookup that selects the top three of 10 matching source rows for every row of a 10k host.

## Seed Phase

Use the shared 10k source/10k host grouped fixture with 10 source matches per host row.

## Execute Phase

Match by dynamic group, sort source amounts descending, limit to three, and full-scan 10k host rows for the exact ordered number arrays.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Exercises number lookup output together with conditional sort and limit.
