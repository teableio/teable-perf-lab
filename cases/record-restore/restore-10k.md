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
2. As unmeasured setup, delete all rows through the engine-specific selection
   delete stream, assert the table is empty, and resolve the matching 10,000-row
   `Record` trash items whose record-id union covers all 10,000 deleted rows.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by the delete stream has been restored. V1 currently
   emits one item; V2 may emit multiple stream-batch items.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 4,999, and 9,999.

## Primary Metric

- `restoreRecords10kMs` (initial guardrail: 180,000 ms).

Delete-to-trash setup and post-restore verification are diagnostic phases and
do not participate in the threshold.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. Registry order runs restore before its destructive delete-stream
sibling when both share one execute database.
