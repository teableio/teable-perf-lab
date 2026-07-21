---
owner: backend-v2
tags: [table-create, inline-records, 5k, primary-only, v1-v2]
enabled: true
---

# table-create/1x-1f-5k-primary-only

## Goal

Measure one primary-only table-create request with 5,000 inline records.
Compared with `table-create/1x-1f-1k-primary-only`, only record count changes.

## Execute Phase

Create one table containing the primary `Title` field and 5,000 deterministic
inline records.

## Primary Metric

- `createTable1x5kRecordsMs`: table-create request time only; initial `maxMs`
  is 20,000.

## Verification

Assert V1/V2 routing, scan all 5,000 rows, and verify rows 1, 2,500, and 5,000.
