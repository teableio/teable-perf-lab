---
owner: backend-v2
tags: [rollup, max, number, 10k, v1-v2, multi-filter]
enabled: true
---

# rollup/conditional-group-active-max-10k

## Goal

Measure adding a conditional maximum with dynamic group matching and a static active-state condition on a 10k host.

## Seed Phase

Use the shared grouped fixture; five of the 10 records in each source group are active.

## Execute Phase

Match by group, filter `A Active=true`, apply `max({values})`, and verify the maximum of the five retained amounts.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Combines numeric aggregation with a two-condition `and` filter group.
