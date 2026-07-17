---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - primary-only
  - v1-v2
enabled: true
---

# record-duplicate/single-50-primary-only

## Goal

Establish the narrowest single-record duplicate baseline by copying 50 source
records from a table that contains only the primary `Title` field.

## Seed Phase

- Creates one reusable one-field table with 100 deterministic records.
- Validates the full source count and exact values for rows 1, 25, and 50.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

1. Read the first 50 source record ids.
2. Call `POST /api/table/{tableId}/record/{recordId}/duplicate` sequentially
   for each source record and time each request independently.
3. Assert HTTP 201, exact duplicated values, and V1/V2 `duplicateRecord`
   routing for every request.
4. Verify all 50 created ids and the final table count of 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over the 50 duplicate requests, guarded
  by an initial 2,000 ms threshold.

Source lookup, verification, final-count scanning, and cleanup are outside the
primary metric.

## Verification

All 50 duplicated titles must match their source values. Rows 1, 25, and 50
are retained as artifact samples.
