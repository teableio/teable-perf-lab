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
2. As unmeasured setup, delete all rows through the engine-specific selection
   delete stream, assert the table is empty, and resolve the matching 1,000-row
   `Record` trash item or items from the table trash.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by the delete stream has been restored.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 499, and 999.

## Primary Metric

- `restoreRecords1kMs` (initial guardrail: 60,000 ms).

Delete-to-trash setup and post-restore verification are diagnostic phases and
do not participate in the threshold.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. Successful local runs leave the shared seed restored and reusable.
