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

1. Verify the seed through a full row-count scan and sample values.
2. As unmeasured setup, delete all rows through the engine-specific selection
   delete stream, assert the table is empty, and resolve the matching 50,000-row
   `Record` trash items whose record-id union covers all 50,000 deleted rows.
   V1 uses two 25,000-row range requests so its attachment cleanup stays below
   PostgreSQL's 32,767 bind-variable ceiling; V2 chunks its by-id stream
   internally.
3. Measure the full ordered set of
   `POST /api/trash/restore/{trashId}?tableId={tableId}` requests until every
   trash item produced by the delete stream has been restored. Both engines may
   therefore emit multiple setup-batch trash items at this scale.
4. Full-scan all restored rows and verify `Title` plus `External ID` at offsets
   0, 24,999, and 49,999.

## Primary Metric

- `restoreRecords50kMs` (initial guardrail: 600,000 ms).

Delete-to-trash setup and post-restore verification are diagnostic phases and
do not participate in the threshold.

## Notes

V2 must report `x-teable-v2-feature: createRecord`; V1 must remain on the
legacy route. The broad first threshold is intentionally correctness-first and
should be tightened after local and CI history exists.
