---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - long-text
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-long-text-10fields

## Goal

Isolate larger string copying by duplicating 50 records from a table containing
primary `Title` plus nine deterministic long-text fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic source records.
- Validates the full source count and sampled long-text values.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially through the single-record endpoint.
Every response must return HTTP 201, match all source values, and prove the
requested V1/V2 `duplicateRecord` route. The final table must contain 150 rows.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

## Verification

All ten cells on all 50 duplicates are checked; rows 1, 25, and 50 are retained
as samples. Source lookup, verification, count scanning, and cleanup are not
timed.
