---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - primary-field
  - narrow-table
  - v1-v2
enabled: true
---

# record-create/1k-primary-text-only-bulk-create

## Goal

Measure the narrowest 1,000-record create request: one title field in a
one-field table.

## Seed Phase

Create one reusable empty table containing only `Title` and build 1,000
deterministic title payloads before timing.

## Execute Phase

Create 1,000 title-only records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify the SQL row count and exact titles on
rows 1, 500, and 1,000.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

This is the narrow-table control for the wide-table title-only case.
