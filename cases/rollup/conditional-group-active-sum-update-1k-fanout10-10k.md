---
owner: backend-v2
tags: [rollup, sum, conditional, propagation, update, 10k, fanout10, v1-v2]
enabled: true
---

# rollup/conditional-group-active-sum-update-1k-fanout10-10k

## Goal

Measure conditional sum propagation when each of 10,000 host rows aggregates five active values from 10 group matches and 1,000 source amounts change.

## Seed Phase

Create a 10k-row source and a 10k-row host with 1,000 groups and fanout 10. Five active amounts per group contribute to every host sum.

## Execute Phase

Create and verify the conditional sum as setup. Then add 1,000,000 to one active amount in every group in one 1,000-record PATCH and scan all host rows until every sum increases by exactly 1,000,000.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk amount update request plus the full readiness scan after recomputation.

## Verification

Poll deterministic sample rows, then page through all 10,000 host rows and verify the exact recomputed sum for every row.

## Notes

This is the low-candidate endpoint of the rollup fanout 10/50/100 propagation curve. Field creation and initial readiness remain setup diagnostics.

## Open Assumptions

- One changed active amount per group represents a broad financial or inventory update.
- The initial 120-second guardrail is intentionally conservative until repeated CI history is available.
