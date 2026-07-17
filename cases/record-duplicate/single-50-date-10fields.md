---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - date
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-date-10fields

## Goal

Isolate date value copying and normalization in a table with primary `Title`
and nine UTC date fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic source records.
- Validates source count and normalized sampled dates.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially through the single-record endpoint.
Every response must return HTTP 201, preserve source dates, and prove matching
V1/V2 `duplicateRecord` routing. The final count must be 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

## Verification

All date cells on all 50 duplicates are compared after calendar-date
normalization; rows 1, 25, and 50 are saved as samples. Verification is not
timed.
