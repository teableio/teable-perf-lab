---
owner: perf-lab
tags: [record-restore, trash, 50k, scale-up, v1-v2]
enabled: true
---

# record-restore/restore-50k

## Goal

Measure restoring 50,000 deleted records from a table's trash through the real
V1/V2 restore route.

## Seed Phase

Use the same deterministic flat record-trash fixture family as the 1k and 10k
cases, scaled to 50,000 rows. The table has 20 stored fields and no links,
lookups, formulas, or other computed dependencies. No existing 50k sibling has
the exact shape yet; future matching cases can reuse this seed identity.

## Execute Phase

1. Verify the seed through a full row-count scan and sample values. The existing
   `seedReady` scan hydrates real IDs through `onRecordId`, replacing synthetic
   cache-hit IDs without an extra scan.
2. As unmeasured `deleteRecordSetup`, require the hydrated pre-mutation IDs to
   be nonempty, then use `deleteAllRowsByEngine`. V1 uses two leading
   25,000-row range `DELETE /api/table/{tableId}/selection/delete` requests so
   attachment cleanup stays below PostgreSQL's 32,767 bind-variable ceiling.
   V2 uses one `POST /api/table/{tableId}/selection/delete-by-id` request with
   `selection.excludeRecordIds: []` for the whole view, chunked internally.
   Assert the table is empty and locate `Record` trash items whose record-id
   union covers all 50,000 pre-delete IDs.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by setup has been restored, including all trash items
   from multiple direct setup batches.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 24,999, and 49,999.

## Primary Metric

- `restoreRecords50kMs` (initial guardrail: 600,000 ms).

Seed readiness/ID hydration, direct delete/trash-poll setup, and post-restore
verification remain outside the restore metric and threshold. Setup does not
use any delete stream route or the V2-only durable-delete benchmark; the primary
restore operation is unchanged. `details.deleteSetup` reports `status`, summed
`deletedCount`, `routing` from the first batch, and `trace` from the last batch,
without stream event counters.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. The broad first threshold is intentionally correctness-first and
should be tightened after local and CI history exists.
