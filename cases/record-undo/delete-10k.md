---
owner: backend-v2
tags:
  - undo-redo
  - undo
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

# record-undo/delete-10k

## Goal

Measure undo replay performance after a user deletes 10,000 mixed-type records
through the grid row-selection delete stream.

This case isolates undo replay. The delete that creates the undo stack is setup,
not part of the primary metric.

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
  engines and workflow runs. The measured undo naturally restores the table to
  seed-ready state; cleanup validates that state before preserving the table.

## Execute Phase

1. Run setup delete before the primary timer:
   - call `GET /api/table/{tableId}/selection/delete-stream`
   - use `ranges=[[0,9999]]`, `type=rows`, the 20-field `projection[]`, the
     first grid `viewId`, and a per-run `x-window-id`
   - wait for the stream `done` event
   - verify the table has no visible records
2. Start the primary timer when the table is deleted and undo is ready.
3. Call `POST /api/table/{tableId}/undo-redo/undo-stream` with the same
   `x-window-id`.
4. Read the `text/event-stream` response until the `done` event reports
   `status: fulfilled`.
5. Stop the primary timer.
6. Full-scan the restored table and verify 10,000 records plus sample values.
7. Cleanup preserves the cached seed table when it is back in seed-ready state,
   otherwise permanently deletes the temporary table.

## Primary Metric

- `undoReplay10kMs`: elapsed time from opening `undo-stream` until the stream
  emits `done` with `status: fulfilled`.

## Notes

The setup delete duration is recorded as `deleteSetup10kMs` for diagnostics, but
it is not thresholded.

V1 is reported as `skipped`: its legacy delete-stream undo path can return
`fulfilled` without restoring this 10,000-row selection-delete fixture in the
e2e harness. The measurable large undo replay path for this case is V2.
