---
owner: backend-v2
tags:
  - record-duplicate
  - record-operation
  - sequential
  - p95
  - multiple-select
  - 10fields
  - v1-v2
enabled: true
---

# record-duplicate/single-50-multiple-select-10fields

## Goal

Isolate multi-value option-array cloning in a table with primary `Title` and
nine multiple-select fields.

## Seed Phase

- Creates one reusable 10-field table with 100 deterministic source records.
- Validates source count and sampled ordered choice arrays.
- Reuses the hash-derived table when seed caching is enabled.

## Execute Phase

Duplicate source rows 1-50 sequentially. Assert HTTP 201, exact choice arrays,
and V1/V2 `duplicateRecord` routing for every response. Require 50 ids and a
final table count of 150.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over 50 requests, initial max 2,000 ms.

## Verification

Every multiple-select array on all 50 duplicates must match its source in
order; rows 1, 25, and 50 are retained. Verification is outside the timer.
