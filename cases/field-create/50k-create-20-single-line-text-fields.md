---
owner: perf-lab
tags: [field-create, 50k, scalar-matrix, scale-up]
enabled: true
---

# field-create/50k-create-20-single-line-text-fields

## Goal

Measure creating 20 single-line text fields on a populated 50,000-row table as the
row-count scale sibling of the existing 10k case.

## Seed Phase

- Reuse the shared deterministic 50,000-row Title-only table.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create 20 single-line text fields sequentially.
- Assert requested-engine routing and exact type metadata for every response.
- Full-scan 1,000,000 created cells and require every value to be empty.
- Retain requests 1, 10, and 20 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all 20 field-create requests, initial maximum 180,000 ms.

## Notes

Seed setup, readiness checks, and empty-value verification are outside the
primary timer. Only populated row count changes from the 10k baseline.
