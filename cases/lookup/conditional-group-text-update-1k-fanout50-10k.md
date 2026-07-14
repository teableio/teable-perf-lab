---
owner: backend-v2
tags:
  [lookup, text, conditional, propagation, update, 10k, 50k, fanout50, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout50-10k

## Goal

Measure conditional text-lookup propagation when each of 10,000 host rows resolves 50 source values and 1,000 source values change.

## Seed Phase

Create a 50k-row source and a 10k-row host with 1,000 groups and fanout 50. Every host row initially returns 50 sorted source text values.

## Execute Phase

Create and verify the conditional lookup as setup. Then update one source text value in every group in one 1,000-record PATCH and scan all 10,000 host rows until every lookup contains the updated value.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after propagation.

## Verification

Poll deterministic sample rows, then page through all 10,000 host rows and verify the complete 50-value result for every row.

## Notes

This is the midpoint of the fanout 10/50/100 propagation curve. Field creation and initial readiness remain setup diagnostics.

## Open Assumptions

- A 1,000-record mutation spread across all groups represents a broad import or automation update.
- The initial 120-second guardrail is intentionally conservative until repeated CI history is available.
