---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - single-line-text
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-single-line-text-fields-bulk-create

## Goal

Measure one 1,000-record create request containing the four single-line text
fields of a 20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and build a deterministic canonical
1,000-row payload before timing. The execute payload projects `Title`,
`Owner Text`, `External ID`, and `Source` only.

## Execute Phase

Call `POST /api/table/{tableId}/record` once with 1,000 typed records,
`fieldKeyType: "name"`, and `typecast: false`. Require 1,000 response IDs and
matching V1/V2 `createRecord` routing. Verify the SQL row count and the first,
middle, and last records; the other sixteen fields must remain empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

Cleanup deletes the created records and revalidates the shared empty fixture
outside the primary timer.
