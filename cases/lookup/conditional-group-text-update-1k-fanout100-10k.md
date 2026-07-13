---
owner: backend-v2
tags: [lookup, text, conditional, propagation, update, 10k, 100k, v1-v2]
enabled: true
---

# lookup/conditional-group-text-update-1k-fanout100-10k

## Goal

Measure how long a populated conditional text lookup takes to become fully correct after 1,000 source values change.

## Seed Phase

Create a 100k-row source and a 10k-row host with 1,000 groups and fanout 100. Every host row initially returns 100 sorted source text values.

## Execute Phase

Create the conditional lookup as setup and verify its initial values. Then update one source text value in every group in one bulk PATCH, for 1,000 updates total, and scan all 10,000 host rows until every lookup contains the updated value.

The mutation changes one input value per group and therefore affects all 10,000 host rows while keeping the million-pair candidate workload fixed.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk source update request plus the full readiness scan after the updates.

## Open Assumptions

- A 1,000-record mutation represents a broad user import or automation update that touches every logical group once.
- Field creation and initial readiness are setup diagnostics, not part of the primary metric.
