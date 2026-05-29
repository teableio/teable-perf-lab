---
owner: backend-v2
tags:
  - selection-duplicate
  - selection-stream
  - table-operation
  - 1k
  - v1-v2
enabled: true
---

# selection-duplicate/flat-1k-row-duplicate-stream

## Goal

Measure the selection duplicate stream path for duplicating 1,000 selected rows
through `GET /api/table/{tableId}/selection/duplicate-stream`.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 1,000 deterministic records in one batch.
- Resolves the first grid view id used by row selection.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.

## Execute Phase

1. Start the primary timer after the source table is ready.
2. Open the duplicate SSE endpoint with `type: rows` and `ranges: [[0, 999]]`.
3. Stop the primary timer after the stream emits the `done` event.
4. Verify the stream reports 1,000 duplicated records and no error events.
5. Full scan the table and verify every deterministic `Index` value appears
   exactly twice.
6. Permanently delete the temporary table.

## Primary Metric

- `duplicate1kMs`: elapsed time from opening the duplicate stream to receiving
  the final `done` event.

## Notes

The initial scale is 1,000 rows because the legacy stream fallback duplicates
records sequentially. This still covers the real UI stream path while keeping
the first CI validation practical; a 10k version can be added after baseline
timings are known.
