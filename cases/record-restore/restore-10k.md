---
owner: perf-lab
tags: [record-restore, trash, 10k, v1-v2]
enabled: true
---

# record-restore/restore-10k

## Goal

Measure restoring 10,000 deleted records from a table's trash through the real
V1/V2 restore route.

## Seed Phase

Reuse the deterministic flat fixture family used by
`record-delete/delete-stream-10k`: one table, 10,000 rows, and 20 stored fields
without links, lookups, formulas, or computed dependencies. The shared seed
identity avoids rebuilding the same source table for the restore case.

## Execute Phase

1. Verify the shared seed through a full row-count scan and sample values.
   Its existing `seedReady` scan uses `onRecordId` to hydrate real IDs, including
   cache hits with synthetic IDs; there is no additional ID scan.
2. As unmeasured `deleteRecordSetup`, require those pre-mutation IDs to be
   nonempty, then use shared direct helper `deleteAllRowsByEngine`: V1 calls
   `DELETE /api/table/{tableId}/selection/delete` over the grid range; V2 calls
   `POST /api/table/{tableId}/selection/delete-by-id` with
   `selection.excludeRecordIds: []` for the whole view (one request, internally
   chunked). Assert the table is empty and locate matching `Record` trash
   items whose record-id union covers the 10,000 pre-delete IDs.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by the direct setup delete has been restored.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 4,999, and 9,999.

## Primary Metric

- `restoreRecords10kMs` (initial guardrail: 180,000 ms).

Seed readiness/ID hydration, direct delete/trash-poll setup, and post-restore
verification are diagnostics outside the primary metric and threshold.
`details.deleteSetup` contains `status`, `deletedCount`, `routing`, and `trace`,
not stream counters. Setup uses neither the V2-only durable-delete benchmark
nor a delete stream route; the measured restore path is unchanged.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. Registry order runs restore before its delete benchmark sibling
when both share one execute database.
