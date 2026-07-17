---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - number
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-number-10fields

## Goal

Isolate numeric cloning and response conversion in a fixed-width table with
primary `Title` and nine number fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic source records.
- Validates source count and exact numeric values on sampled rows.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially through the single-record endpoint.
Assert HTTP 201, exact source values, and V1/V2 `duplicateRecord` routing for
each response. Require 50 duplicate ids and a final table count of 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

## Verification

Every numeric cell on all 50 duplicates must match its source; rows 1, 25, and
50 are saved as samples. Lookup and verification work is outside the timer.
