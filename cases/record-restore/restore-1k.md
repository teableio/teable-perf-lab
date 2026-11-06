---
owner: perf-lab
tags: [record-restore, trash, 1k, v1-v2]
enabled: true
---

# record-restore/restore-1k

## Goal

Measure restoring 1,000 deleted records from a table's trash through the real
V1/V2 restore route.

## Seed Phase

Reuse the deterministic flat fixture family used by
`record-delete/delete-stream-1k`: one table, 1,000 rows, and 20 stored fields
without links, lookups, formulas, or other computed dependencies. The shared
seed identity lets both cases use the same cached table.

## Execute Phase

1. Verify the shared seed through a full row-count scan and sample values.
   The existing `seedReady` scan hydrates real record IDs through `onRecordId`,
   replacing synthetic cache-hit IDs; no extra ID scan is added.
2. As unmeasured `deleteRecordSetup`, require those pre-mutation IDs to be
   nonempty, then call shared direct helper `deleteAllRowsByEngine`: V1 uses
   `DELETE /api/table/{tableId}/selection/delete` with a grid range; V2 uses
   `POST /api/table/{tableId}/selection/delete-by-id` with
   `selection.excludeRecordIds: []` for the whole view. Assert the table is
   empty and locate matching `Record` trash items using the pre-delete IDs.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by the direct setup delete has been restored.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 499, and 999.

## Primary Metric

- `restoreRecords1kMs` (initial guardrail: 60,000 ms).

Seed readiness (including ID hydration), direct delete/trash-poll setup, and
post-restore verification are diagnostics outside the restore metric/threshold.
`details.deleteSetup` records `status`, `deletedCount`, `routing`, and `trace`,
not stream event counts. This setup does not use the V2-only durable-delete
benchmark or any delete stream route; the primary restore route is unchanged.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. Successful local runs leave the shared seed restored and reusable.
