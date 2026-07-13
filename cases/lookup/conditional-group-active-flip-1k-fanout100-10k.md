---
owner: backend-v2
tags: [lookup, text, conditional, propagation, predicate, 10k, 100k, v1-v2]
enabled: true
---

# lookup/conditional-group-active-flip-1k-fanout100-10k

## Goal

Measure conditional lookup propagation when 1,000 source records stop matching the active-state predicate.

## Seed Phase

Create a 100k-row source and a 10k-row host with 1,000 groups and fanout 100. Fifty records per group are active, so every host row initially returns 50 text values.

## Execute Phase

Create and verify the active-filtered lookup as setup. Then flip one active source record to inactive in every group in one bulk PATCH and scan all host rows until each result shrinks from 50 values to 49.

This changes membership rather than only changing the payload of an already-matching value.

## Primary Metric

`conditionalQueryPropagationReadyMs`: predicate updates plus the full readiness scan after membership changes.

## Open Assumptions

- One predicate change per group models a broad status update that affects every host row.
- Field creation and initial readiness are setup diagnostics.
