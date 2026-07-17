---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - checkbox
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-checkbox-fields-bulk-create

## Goal

Measure one 1,000-record create request containing the two checkbox fields of a
20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Active` and `Approved` only.

## Execute Phase

Create 1,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify the boolean/null pattern on rows 1,
500, and 1,000, the SQL row count, and that the other eighteen fields are empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

An absent unchecked checkbox and an explicit false representation are treated
as the same empty boolean state.
