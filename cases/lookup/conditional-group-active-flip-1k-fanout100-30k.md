---
owner: backend-v2
tags: [lookup, text, conditional, propagation, predicate, 30k, 100k, v1-v2]
enabled: true
---

# lookup/conditional-group-active-flip-1k-fanout100-30k

## Goal

Measure conditional lookup propagation when 1,000 predicate changes invalidate a 30,000-row host.

## Seed Phase

Create a 100k-row source and a 30k-row host with 1,000 groups and fanout 100. Fifty records per group are active, so every host row initially returns 50 text values.

## Execute Phase

Create and verify the active-filtered lookup as setup. Then flip one active source record to inactive in every group in one bulk PATCH and scan all host rows until each result shrinks from 50 values to 49.

Compared with the 10k-host variant, the update request stays fixed while predicate-dependent computed cells grow from 10,000 to 30,000.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk predicate update request plus the full readiness scan after membership changes.

## Open Assumptions

- One status change per group models a broad workflow transition on a large dependent table.
- Field creation and initial readiness stay outside the primary metric.
