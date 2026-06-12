---
owner: backend-v2
tags:
  - undo-redo
  - delete
  - selection
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-delete/delete-1k

## Goal

Measure the grid selection delete path for deleting 1,000 mixed-type records
from a 20-field table.

This case isolates delete performance. It does not measure undo or redo replay.

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
  copy, so execute may delete local rows without repairing the shared seed dump.
  Local single-database runs can still replay the matching undo operation during
  cleanup to return the table to seed-ready state.

## Execute Phase

1. Start the primary timer only after the 1k source table is ready.
2. Call `DELETE /api/table/{tableId}/selection/delete` with:
   - `ranges=[[0,0],[0,999]]`
   - the first grid `viewId`
   - a stable per-run `x-window-id`
3. Assert the response routing matches the requested V1/V2 engine.
4. Stop the primary timer after the JSON response returns 1,000 deleted ids.
5. Record routing headers such as `x-teable-v2`, `x-teable-v2-feature`, and
   `x-teable-v2-reason` in the run artifact.
6. Verify the table has no visible records.
7. Cleanup restores the cached seed table when a single database is being reused
   across engines, otherwise the isolated execute database is discarded after
   the job.

## Primary Metric

- `delete1kMs`: elapsed time for the synchronous selection delete request.

The timer starts after the 1k-row source table has passed `seedReady` and stops
when the selection-delete response returns with 1,000 deleted ids. It does not
include seed preparation, pre-delete full-scan validation, post-delete empty
table verification, undo-based cleanup, or seed-cache restore/build work; those
are emitted separately as diagnostic metrics such as `prepareMs`, `seedReadyMs`,
plus the `verifyDeleted` phase.

## Notes

The `x-window-id` header is still sent so the request matches real grid
behavior and can populate the undo stack, but this case does not replay it.
