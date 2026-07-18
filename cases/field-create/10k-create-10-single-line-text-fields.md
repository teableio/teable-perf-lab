---
owner: perf-lab
tags: [field-create, 10k, single-line-text, scalar-matrix]
enabled: true
---

# field-create/10k-create-10-single-line-text-fields

## Goal

Isolate homogeneous single-line text schema-mutation cost across ten sequential
field-create requests on a populated table.

## Seed Phase

- Reuse the Batch 12 shared 10,000-row table containing primary `Title` only.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create ten single-line text fields sequentially.
- Assert requested-engine routing and exact metadata for every response.
- Full-scan 100,000 created cells and require every value to be empty.
- Retain requests 1, 5, and 10 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all ten field-create requests, maximum 20,000 ms.

## Notes

This is the fixed-request-count comparison for the other ten-field types.
