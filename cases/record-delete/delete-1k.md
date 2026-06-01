---
owner: backend-v2
tags:
  - undo-redo
  - delete
  - selection
  - stream
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-delete/delete-1k

## Goal

Measure the grid row-selection delete stream for deleting 1,000 mixed-type
records from a 20-field table.

This case isolates delete performance. It does not measure undo or redo replay.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the staging Tibo test shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 1,000 deterministic records in one 1,000-record batch.
- Uses a plain grid view with no sort, filter, or group so row range
  `[[0,999]]` maps to the full inserted dataset.
- Verifies the source table is ready by full-scanning 1,000 records and checking
  sample rows `0`, `499`, and `999`.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may delete local rows without repairing the shared seed dump.
  Local single-database runs can still replay the matching undo operation during
  cleanup to return the table to seed-ready state.

## Execute Phase

1. Start the primary timer only after the 1k source table is ready.
2. Call `GET /api/table/{tableId}/selection/delete-stream` with:
   - `ranges=[[0,999]]`
   - `type=rows`
   - the 20-field `projection[]`
   - the first grid `viewId`
   - a stable per-run `x-window-id`
3. Read the `text/event-stream` response until the `done` event.
4. Stop the primary timer after the stream reports all 1,000 rows deleted.
5. Verify the table has no visible records.
6. Cleanup restores the cached seed table when a single database is being reused
   across engines, otherwise the isolated execute database is discarded after
   the job.

## Primary Metric

- `delete1kMs`: elapsed time from opening `delete-stream` until the stream
  emits `done`.

## Notes

The `x-window-id` header is still sent so the request matches real grid
behavior and can populate the undo stack, but this case does not replay it.
