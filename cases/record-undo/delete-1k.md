---
owner: backend-v2
tags:
  - undo-redo
  - undo
  - delete
  - selection
  - stream
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-undo/delete-1k

## Goal

Measure undo replay performance after a user deletes 1,000 mixed-type records
through the grid selection delete path.

This case isolates undo replay. The delete that creates the undo stack is setup,
not part of the primary metric.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the staging Tibo test shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 1,000 deterministic records in one 1,000-record batch.
- Uses a plain grid view with no sort, filter, or group so cell range
  `[[0,0],[0,999]]` maps to the first visible column across the full inserted
  dataset.
- Verifies the source table is ready by full-scanning 1,000 records and checking
  the expected row count.
- When seed cache is enabled, the hash-derived source table is reused across
  engines and workflow runs. The measured undo naturally restores the table to
  seed-ready state; cleanup validates that state before preserving the table.

## Execute Phase

1. Run setup delete before the primary timer:
   - call `DELETE /api/table/{tableId}/selection/delete`
   - use `ranges=[[0,0],[0,999]]`, the first grid `viewId`, and a per-run
     `x-window-id`
   - wait for the JSON response to return 1,000 deleted ids
   - verify the table has no visible records
2. Start the primary timer when the table is deleted and undo is ready.
3. Call `POST /api/table/{tableId}/undo-redo/undo-stream` with the same
   `x-window-id`.
4. Read the `text/event-stream` response until the `done` event reports
   `status: fulfilled`, then assert `done.engine` matches the requested V1/V2
   engine.
5. Stop the primary timer.
6. Full-scan the restored table and verify 1,000 records plus sample values.
7. Cleanup preserves the cached seed table when it is back in seed-ready state,
   otherwise permanently deletes the temporary table.

## Primary Metric

- `undoReplay1kMs`: elapsed time from opening `undo-stream` until the stream
  emits `done` with `status: fulfilled`.

## Notes

The setup delete duration is recorded as `deleteSetup1kMs` for diagnostics, but
it is not thresholded.
