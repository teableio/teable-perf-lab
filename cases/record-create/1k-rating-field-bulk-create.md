---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - rating
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-rating-field-bulk-create

## Goal

Measure one 1,000-record create request containing only the rating field of a
20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Score` only.

## Execute Phase

Create 1,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify bounded rating values on rows 1, 500,
and 1,000, the SQL row count, and that the other nineteen fields are empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

The one-field payload retains the full mixed schema, separating cell-family
cost from schema width.
