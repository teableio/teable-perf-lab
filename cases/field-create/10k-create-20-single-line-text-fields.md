---
owner: perf-lab
tags: [field-create, 10k, single-line-text, width-scaling]
enabled: true
---

# field-create/10k-create-20-single-line-text-fields

## Goal

Measure homogeneous request-count scaling by doubling the ten-field text
workload to twenty sequential field-create requests.

## Seed Phase

- Reuse the Batch 12 shared 10,000-row Title-only table.
- Verify all source records are readable and remove any execute-created fields.

## Execute Phase

- Create twenty single-line text fields sequentially.
- Assert requested-engine routing and exact metadata for every response.
- Full-scan 200,000 created cells and require every value to be empty.
- Retain requests 1, 10, and 20 as trace evidence.

## Primary Metric

- `createScalarFieldsMs`: all twenty field-create requests, maximum 40,000 ms.

## Notes

This is the request-count comparison for the ten-field text sibling.
