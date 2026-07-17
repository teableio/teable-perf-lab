---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - primary-field
  - wide-table
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-wide-table-title-only-bulk-create

## Goal

Measure a one-field 1,000-record create payload against a 20-field mixed table
to expose schema-width overhead independently of request width.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Title` only.

## Execute Phase

Create 1,000 title-only records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify the SQL row count, exact titles on rows
1, 500, and 1,000, and that all nineteen omitted fields remain empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

Compare this directly with `record-create/1k-primary-text-only-bulk-create` to
separate table-schema width from payload width.
