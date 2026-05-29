---
owner: backend-v2
tags:
  - record-delete
  - selection
  - table-operation
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# record-delete/flat-10k-row-delete

## Goal

Measure the grid row delete path for deleting 10,000 selected records through
`DELETE /api/table/{tableId}/selection/delete`.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 10,000 deterministic records in 1,000-record batches.
- Resolves the first grid view id used by row selection.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.

## Execute Phase

1. Start the primary timer after the source table is ready.
2. Call `DELETE /selection/delete` with `type: rows` and `ranges: [[0, 9999]]`.
3. Stop the primary timer after the delete response returns.
4. Verify the delete response includes 10,000 record ids.
5. Read the table and verify no records remain.
6. Permanently delete the temporary table.

## Primary Metric

- `delete10kMs`: elapsed time for the single selection-delete request.

## Notes

This case uses selection delete rather than a huge `recordIds` query string, so
it mirrors the table UI path and keeps the request shape small.
