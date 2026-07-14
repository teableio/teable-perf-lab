---
owner: backend-v2
tags:
  [lookup, text, conditional, propagation, update, 10k, 100k, limit10, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout100-limit10-10k

## Goal

Measure propagation when every host row sorts 100 matching source records but stores only the first 10 text values after a source update.

## Seed Phase

Create a 100k-row source and a 10k-row host with 1,000 groups and fanout 100. Every host row initially returns the first 10 of 100 amount-sorted source text values.

## Execute Phase

Create and verify the conditional lookup as setup. Then update the first sorted source text value in every group in one 1,000-record PATCH and scan all host rows until every limited result is correct.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after propagation.

## Verification

Poll deterministic sample rows, then page through all 10,000 host rows and verify the exact ordered 10-value result for every row.

## Notes

Paired with limit 50 and the existing limit 100 case, this isolates stored result width while keeping 100 candidates and 10,000 affected host rows fixed.

## Open Assumptions

- Updating the first sorted value guarantees the changed value remains inside every limited result.
- The initial 120-second guardrail is intentionally conservative until repeated CI history is available.
