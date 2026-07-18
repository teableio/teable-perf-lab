---
owner: perf-lab
tags: [field-create, 10k, date, scalar-matrix]
enabled: true
---

# field-create/10k-create-10-date-fields

## Goal

Isolate UTC date field metadata and column creation across ten sequential
requests on a populated table.

## Seed Phase

- Reuse the Batch 12 shared 10,000-row Title-only table.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create ten UTC date fields sequentially.
- Assert requested-engine routing, type, and date-formatting metadata.
- Full-scan 100,000 created cells and require every value to be empty.
- Retain requests 1, 5, and 10 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all ten field-create requests, maximum 40,000 ms.

## Notes

Readiness and empty-value verification are outside the primary timer.
