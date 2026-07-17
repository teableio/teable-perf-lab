---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - checkbox
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-checkbox-10fields

## Goal

Isolate boolean and empty-state copying in a table with primary `Title` and
nine checkbox fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic alternating
  checkbox records.
- Validates source count and sampled values.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially. Assert HTTP 201, source-equivalent
cells, and V1/V2 `duplicateRecord` routing for every request. Require 50 ids
and a final table count of 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

## Verification

All checkbox and empty states on all 50 duplicates must match; rows 1, 25, and
50 are saved as samples. Lookup, verification, and cleanup are excluded.
