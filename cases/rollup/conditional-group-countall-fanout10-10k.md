---
owner: backend-v2
tags: [rollup, count, 10k, v1-v2, fanout]
enabled: true
---

# rollup/conditional-group-countall-fanout10-10k

## Goal

Measure adding a conditional count-all rollup over 10 matching source rows for every row of a 10k host.

## Seed Phase

Use the shared 10k source/10k host grouped fixture with 1,000 groups and fanout 10.

## Execute Phase

Match by dynamic group, apply `countall({values})`, and verify that every host row reports 10.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Represents conditional record-count fields without a pre-existing Link field.
