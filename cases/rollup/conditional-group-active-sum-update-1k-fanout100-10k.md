---
owner: backend-v2
tags: [rollup, sum, conditional, propagation, update, 10k, 100k, v1-v2]
enabled: true
---

# rollup/conditional-group-active-sum-update-1k-fanout100-10k

## Goal

Measure how long an existing conditional sum takes to recompute after 1,000 active source amounts change.

## Seed Phase

Create a 100k-row source and a 10k-row host with 1,000 groups and fanout 100. Fifty active amounts per group contribute to every host sum.

## Execute Phase

Create and verify the active amount sum as setup. Then add 1,000,000 to one active amount in every group in one bulk PATCH and scan all host rows until every sum increases by exactly 1,000,000.

The update touches 1,000 source records but invalidates all 10,000 host aggregates.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk amount update request plus the full readiness scan after recomputation.

## Open Assumptions

- One changed active amount per group represents a broad financial or inventory update.
- The large deterministic delta makes stale and recomputed sums unambiguous.
- Field creation and initial readiness are setup diagnostics.
