---
owner: backend-v2
tags:
  - field
  - duplicate
  - 10k
  - multiple-select
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-tags-field

## Goal

Measure duplicating one populated multiple-select field and its 10,000 arrays.

## Seed Phase

- Create a table with primary `Title` and multiple-select `Tags` using four
  deterministic options and two values per row.
- Insert 10,000 deterministic records in 1,000-row batches.
- Full-scan the seed and verify rows 1, 5,000, and 10,000.

## Execute Phase

1. Resolve `Tags`, then start the primary timer.
2. Duplicate it to `Tags Copy` through the public field endpoint.
3. Stop the timer after status and V1/V2 routing assertions pass.
4. Verify the copied field type and compare source and copy arrays across all
   10,000 rows.

## Primary Metric

- `duplicateScalarFieldMs`: synchronous field-duplicate request latency. Seed,
  resolution, verification, and cleanup are excluded.

## Notes

The initial 10-second guardrail is intentionally uncalibrated and will be
replaced with a CI-derived bound before merge. The route must report canary
feature `duplicateField`.
