---
owner: backend-v2
tags: [lookup, text, conditional, propagation, update, 10k, fanout10, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout10-10k

## Goal

Measure conditional text-lookup propagation when each of 10,000 host rows resolves 10 source values and 1,000 source values change.

## Seed Phase

Create a 10k-row source and a 10k-row host with 1,000 groups and fanout 10. Every host row initially returns 10 sorted source text values.

## Execute Phase

Create and verify the conditional lookup as setup. Then update one source text value in every group in one 1,000-record PATCH and scan all 10,000 host rows until every lookup contains the updated value.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after propagation.

## Verification

Poll deterministic sample rows, then page through all 10,000 host rows and verify the complete 10-value result for every row.

## Notes

This is the low-candidate endpoint of the fanout 10/50/100 propagation curve. Field creation and initial readiness remain setup diagnostics.

## Open Assumptions

- A 1,000-record mutation spread across all groups represents a broad import or automation update.
- The initial 120-second guardrail is intentionally conservative until repeated CI history is available.
