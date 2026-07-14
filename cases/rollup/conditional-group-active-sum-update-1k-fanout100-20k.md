---
owner: backend-v2
tags: [rollup, sum, conditional, propagation, update, 20k, 100k, v1-v2]
enabled: true
---

# rollup/conditional-group-active-sum-update-1k-fanout100-20k

## Goal

Measure conditional sum propagation when the same 1,000-record source update invalidates 20,000 host aggregates.

## Seed Phase

Create a 100k-row source and a 20k-row host with 1,000 groups and fanout 100. Fifty active amounts per group contribute to every host sum.

## Execute Phase

Create and verify the conditional sum as setup. Then add 1,000,000 to one active amount in every group in one bulk PATCH and scan all 20,000 host rows until every sum increases by exactly 1,000,000.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk amount update request plus the full readiness scan after recomputation.

## Verification

Poll deterministic sample rows, then page through all 20,000 host rows and verify the exact recomputed sum for every row.

## Notes

This fills the midpoint of the existing 10k/30k host-size curve while keeping source size, fanout, mutation size, and rollup configuration fixed.

## Open Assumptions

- Twenty thousand host rows are sufficient to reveal whether the 10k-to-30k V2 growth is linear or superlinear without reproducing the full customer table.
- The initial 360-second guardrail is intentionally conservative until repeated CI history is available.
