---
owner: backend-v2
tags:
  - undo-redo
  - redo
  - delete
  - selection
  - stream
  - 10k
  - 20fields
  - mixed-fields
  - v1-v2
  - large-data
enabled: true
---

# record-redo/delete-10k

## Goal

Measure redo replay performance after a user deletes 10,000 mixed-type records
and then undoes that delete.

This case isolates redo replay. Both setup delete and setup undo happen before
the primary timer starts.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the staging Tibo test shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Uses a plain grid view with no sort, filter, or group so row range
  `[[0,9999]]` maps to the full inserted dataset.
- Verifies the source table is ready by full-scanning 10,000 records and
  checking sample rows `0`, `4999`, and `9999`.
- When seed cache is enabled, the hash-derived source table is reused across
  engines and workflow runs. After execute redoes the delete, cleanup replays
  the matching undo operation to return the cached table to seed-ready state.

## Execute Phase

1. Run setup delete before the primary timer:
   - call `GET /api/table/{tableId}/selection/delete-stream`
   - use `ranges=[[0,9999]]`, `type=rows`, the 20-field `projection[]`, the
     first grid `viewId`, and a per-run `x-window-id`
   - wait for the stream `done` event
   - verify the table has no visible records
2. Run setup undo before the primary timer:
   - call `POST /api/table/{tableId}/undo-redo/undo-stream`
   - use the same `x-window-id`
   - wait for `done` with `status: fulfilled`
   - full-scan the restored table and verify 10,000 records plus sample values
3. Start the primary timer when redo is ready.
4. Call `POST /api/table/{tableId}/undo-redo/redo-stream` with the same
   `x-window-id`.
5. Read the `text/event-stream` response until the `done` event reports
   `status: fulfilled`.
6. Stop the primary timer.
7. Verify the table has no visible records.
8. Cleanup restores the cached seed table when reusable, otherwise permanently
   deletes the temporary table.

## Primary Metric

- `redoReplay10kMs`: elapsed time from opening `redo-stream` until the stream
  emits `done` with `status: fulfilled`.

## Notes

The setup durations are recorded as `deleteSetup10kMs` and `undoSetup10kMs` for
diagnostics, but only `redoReplay10kMs` is thresholded.

V1 is reported as `skipped`: its legacy delete-stream undo/redo path can return
`fulfilled` without restoring this 10,000-row selection-delete fixture in the
e2e harness. The measurable large redo replay path for this case is V2.
