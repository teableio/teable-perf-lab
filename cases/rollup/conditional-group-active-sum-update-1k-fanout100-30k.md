---
owner: backend-v2
tags: [rollup, sum, conditional, propagation, update, 30k, 100k, v1-v2]
enabled: true
---

# rollup/conditional-group-active-sum-update-1k-fanout100-30k

## Goal

Measure conditional sum propagation when the same 1,000 amount changes invalidate 30,000 host aggregates.

## Seed Phase

Create a 100k-row source and a 30k-row host with 1,000 groups and fanout 100. Fifty active amounts per group contribute to every host sum.

## Execute Phase

Create and verify the active amount sum as setup. Then add 1,000,000 to one active amount in every group in one bulk PATCH and scan all host rows until every sum increases by exactly 1,000,000.

Compared with the 10k-host variant, the request and changed aggregate inputs stay fixed while recomputed host sums grow threefold to 30,000.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk amount update request plus the full readiness scan after recomputation.

## Open Assumptions

- A 30k-row host represents financial or inventory summaries reused across a large operational table while remaining practical for routine CI.
- The deterministic delta makes stale and recomputed sums easy to distinguish.
- Field creation and initial readiness stay outside the primary metric.
