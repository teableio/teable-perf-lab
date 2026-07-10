---
owner: backend-v2
tags: [lookup, computed, 10k, v1-v2, fanout]
enabled: true
---

# lookup/conditional-group-text-fanout10-10k

## Goal

Measure adding a conditional text lookup to a 10k-row host where every row resolves 10 records from a 10k-row source.

## Seed Phase

Build one 10k source and one 10k host. The source has 1,000 groups of 10 rows; host rows reference permuted groups.

## Execute Phase

Create a text lookup filtered by the current row's group, sort by amount ascending, limit to 10, then verify all 100,000 returned values through a 10k-row scan.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Paired with the other grouped conditional-query cases through one shared seed.
