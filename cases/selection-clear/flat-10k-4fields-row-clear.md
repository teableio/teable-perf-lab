---
owner: backend-v2
tags:
  - selection-clear
  - table-operation
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# selection-clear/flat-10k-4fields-row-clear

## Goal

Measure the grid clear path for clearing every visible cell across 10,000 rows
and four fields through
`PATCH /api/table/{tableId}/selection/clear-stream`.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 10,000 deterministic records in 1,000-record batches.
- Resolves the first grid view id and visible field ids.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.

## Execute Phase

1. Start the primary timer after the source table is ready.
2. Call `PATCH /selection/clear-stream` with the product large-selection shape:
   `ranges: [[0, 0], [3, 9999]]`, `projection`, and `viewId`.
3. Stop the primary timer after the clear stream emits its final `done` event.
4. Full scan all 10,000 records and verify the selected fields are empty.
5. Permanently delete the temporary table.

## Primary Metric

- `clear10kMs`: elapsed time for the single selection-clear stream request.

## Notes

The product switches clear to the stream endpoint when the affected row count is
greater than 200. This 10k case intentionally measures that large-clear path. It
measures clearing content, not deleting records, so verification expects the row
count to remain 10,000.
