---
owner: backend-v2
tags: [lookup, text, conditional, propagation, update, 20k, 100k, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout100-20k

## Goal

Measure conditional text-lookup propagation when the same 1,000-record source update invalidates a 20,000-row host.

## Seed Phase

Create a 100k-row source and a 20k-row host with 1,000 groups and fanout 100. Every host row initially returns 100 sorted source text values.

## Execute Phase

Create and verify the conditional lookup as setup. Then update one source text value in every group in one bulk PATCH and scan all 20,000 host rows until every lookup contains the updated value.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after propagation.

## Verification

Poll deterministic sample rows, then page through all 20,000 host rows and verify the complete 100-value result for every row.

## Notes

This fills the midpoint of the existing 10k/30k host-size curve while keeping source size, fanout, mutation size, and field configuration fixed.

## Open Assumptions

- Twenty thousand host rows are sufficient to reveal whether the 10k-to-30k V2 growth is linear or superlinear without reproducing the full customer table.
- The initial 360-second guardrail is intentionally conservative until repeated CI history is available.
