---
owner: perf-lab
tags: [field-create, 10k, single-select, scalar-matrix]
enabled: true
---

# field-create/10k-create-10-single-select-fields

## Goal

Isolate single-select option creation by adding ten fields with the same three
deterministic choices.

## Seed Phase

- Reuse the Batch 12 shared 10,000-row Title-only table.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create ten single-select fields sequentially.
- Assert routing plus exact choice names, order, and colors for every field.
- Full-scan 100,000 created cells and require every value to be empty.
- Retain requests 1, 5, and 10 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all ten field-create requests, maximum 20,000 ms.

## Notes

Readiness and empty-value verification are outside the primary timer.
