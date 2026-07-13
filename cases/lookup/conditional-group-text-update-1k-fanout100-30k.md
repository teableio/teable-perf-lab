---
owner: backend-v2
tags: [lookup, text, conditional, propagation, update, 30k, 100k, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout100-30k

## Goal

Measure conditional text-lookup propagation when the same 1,000-record bulk update fans out across a 30,000-row host.

## Seed Phase

Create a 100k-row source and a 30k-row host with 1,000 groups and fanout 100. Every host row initially returns 100 sorted source text values, for 3 million candidate match pairs.

## Execute Phase

Create and verify the conditional lookup as setup. Then update one source text value in every group in one bulk PATCH and scan all 30,000 host rows until every lookup contains the updated value.

Compared with the 10k-host variant, the request and 1,000 changed source inputs stay fixed while affected computed cells and match contributions grow threefold to 30,000.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after the updates.

## Open Assumptions

- A 30k-row host models a heavily reused reference table while remaining practical for routine V1/V2 CI.
- Field creation and initial readiness stay outside the primary metric.
