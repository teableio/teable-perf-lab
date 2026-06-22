---
owner: backend-v2
tags:
  - record-delete
  - stream
  - selection
  - delete
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-delete/delete-stream-1k

## Goal

Measure the grid **streaming** selection-delete path for deleting every record
of a 1,000-row, 20-field table. This is the streaming sibling of
`record-delete/delete-1k`: the product switches a selection delete to the stream
endpoints once the affected row count crosses ~200, so a 1k delete in the real
UI never uses the synchronous endpoint the sync case measures.

This is a real V1/V2 comparison: the behavior exists on both engines through
their respective stream endpoints, so each engine drives the endpoint its own
grid uses.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the sync record-delete shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 1,000 deterministic records in one 1,000-record batch.
- Uses a plain grid view with no sort, filter, or group so the rows-range
  `[[0, 999]]` maps to the full inserted dataset.
- Verifies the source table is ready by full-scanning 1,000 records and checking
  the expected row count (`seedReady` phase).
- Reuses the shared record-replay seed but hashes this runner's own file, so the
  streaming case gets its own seed table distinct from the sync delete seed.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may delete local rows without repairing the shared seed dump.

## Execute Phase

1. Start the primary timer only after the 1k source table is ready.
2. Drive the streaming delete of the whole selection, engine-dispatched:
   - **V1**: `GET /api/table/{tableId}/selection/delete-stream` with the
     rows-range query params `type=rows`, `ranges=[[0, 999]]`, `viewId`,
     `projection` (the legacy range stream).
   - **V2**: `PATCH /api/table/{tableId}/selection/delete-by-id-stream` with
     body `{ viewId, selection: { allRecords: true } }` (the by-id stream).
     Read the SSE to the `done` event.
3. Assert the stream response routing matches the requested V1/V2 engine.
4. Stop the primary timer after the stream emits its final `done` event.
5. Verify the table has no visible records.
6. Cleanup drops the execute table (delete-all is the measured workload, so the
   empty post-state is not a reusable seed); isolated CI execute databases are
   discarded after the job.

## Primary Metric

- `deleteStream1kMs`: elapsed time for the single streaming selection-delete
  request, from the stream call until its final `done` event.

The timer starts after the 1k-row source table has passed `seedReady` and stops
when the delete stream's `done` event reports 1,000 deleted ids. It does not
include seed preparation, the pre-delete full-scan, post-delete empty-table
verification, cleanup, or seed-cache restore/build work; those are emitted
separately as diagnostic metrics and phases.

## Verification

- The stream `done` event must report `totalCount`, `deletedCount`, and
  `data.deletedRecordIds.length` all equal to 1,000, with no `error` events.
- The table must contain no visible records after the delete.
- V1 and V2 both run, and the run fails if routing falls back to the wrong
  engine.

## Notes

The product streams any selection delete with more than ~200 effective rows
(`DELETE_SELECTION_STREAM_ROW_THRESHOLD = 200`). The existing
`record-delete/delete-1k` measures the **synchronous** delete
(`DELETE /selection/delete` v1 / `POST /selection/delete-by-id` v2), which is the
small-selection path; this case fills the gap by measuring the stream path the
1k-row UI actually uses. Keep both cases.

Each engine deletes the same selection through the endpoint its own grid uses,
so the metric compares the user behavior rather than one endpoint: V1 routes to
the range-based `GET /selection/delete-stream` (`x-teable-v2: false`, no feature
header), V2 routes to the by-id `PATCH /selection/delete-by-id-stream`
(`x-teable-v2: true`, `x-teable-v2-feature: deleteRecord`). Both legs are
`@UseV2Feature('deleteRecord')` and emit `IDeleteSelectionStreamEvent`, so the
done-event parsing and routing assertion are identical across engines.

On a seed-cache hit only the row COUNT is restored, not the real record ids, so
the V2 by-id selection uses `selection.allRecords` (the server resolves the
query-scoped ids) instead of an explicit `recordIds` list. The same robustness
is why the V1 leg deletes by a rows-range over `[[0, 999]]` rather than by id.
The HTTP method differs per leg: V1 `delete-stream` is a `GET` with query params,
V2 `delete-by-id-stream` is a `PATCH` with a JSON body.
