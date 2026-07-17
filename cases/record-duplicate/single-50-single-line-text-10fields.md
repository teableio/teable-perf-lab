---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - single-line-text
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-single-line-text-10fields

## Goal

Isolate single-line text copy and response serialization by duplicating 50
records from a fixed-width table containing `Title` and nine text fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic records.
- Validates the full source count and exact text values for rows 1, 25, and 50.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate the first 50 source records sequentially through
`POST /api/table/{tableId}/record/{recordId}/duplicate`. Each request must
return HTTP 201, exact source values, and matching V1/V2 `duplicateRecord`
routing. The post-run scan requires all 50 ids and a final count of 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

Lookup, verification, final-count scanning, and cleanup are excluded.

## Verification

All ten text cells on all 50 duplicated records must match the corresponding
source rows; rows 1, 25, and 50 are saved as samples.
