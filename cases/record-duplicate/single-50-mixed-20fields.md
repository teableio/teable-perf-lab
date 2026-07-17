---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - mixed-fields
  - 20fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-mixed-20fields

## Goal

Provide a 50-request wide-table comparison using the established 20-field mix
of text, select, number, date, checkbox, and rating cells.

## Seed Phase

- Creates one reusable 20-field table with 100 deterministic source records.
- Validates source count and sampled values across every field type.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially through the single-record endpoint.
Every response must return HTTP 201, match all source cells, and prove the
requested V1/V2 `duplicateRecord` route. The final table count must be 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

Source lookup, verification, final-count scanning, and cleanup are excluded.

## Verification

All twenty cells on all 50 duplicated records must match their source; rows 1,
25, and 50 are retained as artifact samples.
