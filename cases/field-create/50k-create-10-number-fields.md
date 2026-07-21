---
owner: perf-lab
tags: [field-create, 50k, scalar-matrix, scale-up]
enabled: true
---

# field-create/50k-create-10-number-fields

## Goal

Measure creating 10 number fields on a populated 50,000-row table as the
row-count scale sibling of the existing 10k case.

## Seed Phase

- Reuse the shared deterministic 50,000-row Title-only table.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create 10 number fields sequentially.
- Assert requested-engine routing and exact type metadata for every response.
- Full-scan 500,000 created cells and require every value to be empty.
- Retain requests 1, 5, and 10 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all 10 field-create requests, initial maximum 120,000 ms.

## Notes

Seed setup, readiness checks, and empty-value verification are outside the
primary timer. Only populated row count changes from the 10k baseline.
