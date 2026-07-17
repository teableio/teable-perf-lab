---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - multiple-select
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-multiple-select-fields-bulk-create

## Goal

Measure one 1,000-record create request containing the two multiple-select
fields of a 20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Tags` and `Labels` only.

## Execute Phase

Create 1,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify ordered choice arrays on rows 1, 500,
and 1,000, the SQL row count, and that the other eighteen fields are empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

This isolates array validation and storage while holding row count and table
schema constant.
