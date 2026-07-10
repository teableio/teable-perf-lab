---
owner: backend-v2
tags: [rollup, array-join, 10k, v1-v2, sort-limit]
enabled: true
---

# rollup/conditional-group-text-top3-10k

## Goal

Measure adding a conditional text array-join over the top three of 10 matching source rows for every row of a 10k host.

## Seed Phase

Use the shared 10k source/10k host grouped fixture with deterministic amounts and text.

## Execute Phase

Match by group, sort amounts descending, limit to three, apply `array_join({values})`, and verify each ordered joined string.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Exercises conditional rollup sorting and limit before text aggregation.
