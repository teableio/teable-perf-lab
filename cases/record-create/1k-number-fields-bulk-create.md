---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - number
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-number-fields-bulk-create

## Goal

Measure one 1,000-record create request containing the three numeric fields of
a 20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Amount`, `Quantity`, and `Percent` only.

## Execute Phase

Create 1,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify exact numeric values on rows 1, 500,
and 1,000, the SQL row count, and that the other seventeen fields are empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

This isolates decimal, integer, and percentage-like numeric storage without
changing the table schema.
