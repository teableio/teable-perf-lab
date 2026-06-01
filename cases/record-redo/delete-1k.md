---
owner: backend-v2
tags:
  - undo-redo
  - redo
  - delete
  - selection
  - stream
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-redo/delete-1k

## Goal

Measure redo replay performance after a user deletes 1,000 mixed-type records
and then undoes that delete.

This case isolates redo replay. Both setup delete and setup undo happen before
the primary timer starts.

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
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may redo the delete locally without repairing the shared seed
  dump. Local single-database runs can still replay the matching undo operation
  during cleanup to return the table to seed-ready state.

## Execute Phase

1. Run setup delete before the primary timer:
   - call `DELETE /api/table/{tableId}/selection/delete`
   - use `ranges=[[0,0],[0,999]]`, the first grid `viewId`, and a per-run
     `x-window-id`
   - wait for the JSON response to return 1,000 deleted ids
   - verify the table has no visible records
2. Run setup undo before the primary timer:
   - call `POST /api/table/{tableId}/undo-redo/undo-stream`
   - use the same `x-window-id`
   - wait for `done` with `status: fulfilled`
   - full-scan the restored table and verify 1,000 records plus sample values
3. Start the primary timer when redo is ready.
4. Call `POST /api/table/{tableId}/undo-redo/redo-stream` with the same
   `x-window-id`.
5. Read the `text/event-stream` response until the `done` event reports
   `status: fulfilled`.
6. Stop the primary timer.
7. Verify the table has no visible records.
8. Cleanup restores the cached seed table when a single database is being reused
   across engines, otherwise the isolated execute database is discarded after
   the job.

## Primary Metric

- `redoReplay1kMs`: elapsed time from opening `redo-stream` until the stream
  emits `done` with `status: fulfilled`.

## Notes

The setup durations are recorded as `deleteSetup1kMs` and `undoSetup1kMs` for
diagnostics, but only `redoReplay1kMs` is thresholded. The 1,000-row workload is
small enough to exercise the same user operation in both V1 and V2, making this
case suitable for engine comparison.
