---
owner: perf-lab
tags: [field-create, 10k, single-line-text, scalar-matrix]
enabled: true
---

# field-create/10k-create-1-single-line-text-field

## Goal

Establish the lower-bound field-create cost by adding one empty single-line text
field to a deterministic 10,000-record table.

## Seed Phase

- Reuse the Batch 12 shared 10,000-row table containing primary `Title` only.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create one single-line text field through the public field API.
- Assert requested-engine routing and exact field metadata.
- Full-scan all 10,000 created cells and require every value to be empty.
- Retain request 1 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: the one field-create request, maximum 5,000 ms.

## Notes

Seed restore, readiness, verification, and cleanup are outside the metric.
