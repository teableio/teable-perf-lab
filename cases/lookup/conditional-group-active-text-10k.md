---
owner: backend-v2
tags: [lookup, computed, 10k, v1-v2, multi-filter]
enabled: true
---

# lookup/conditional-group-active-text-10k

## Goal

Measure adding a conditional text lookup with a dynamic group condition plus a static active-state condition on a 10k host.

## Seed Phase

Use the shared 10k source/10k host fixture; each group has 10 rows and five are active.

## Execute Phase

Match the current host group, require `A Active=true`, sort by amount, and verify five text results for every host row.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Notes

Exercises an `and` filter group containing both field-reference and literal conditions.
