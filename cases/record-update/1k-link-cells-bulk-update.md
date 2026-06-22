---
owner: backend-v2
tags:
  - record-update
  - link
  - 1k
  - v1-v2
  - relationship
enabled: true
---

# record-update/1k-link-cells-bulk-update

## Goal

Measure bulk editing of 1,000 many-one link cells. Updating link cells stresses
link-target resolution, relationship writes, and link display-value refresh
differently from the scalar bulk-update path, matching the product action of
re-pointing linked records across many rows.

The measured request is the multi-record update
`PATCH /api/table/{tableId}/record` (canary feature `updateRecords`).

## Seed Phase

- Creates a foreign table of 1,000 rows whose primary `Key` titles are
  `fk-<paddedRow>`, and a host table of 1,000 rows with `Title` plus a one-way
  many-one `Linked` field pointing at the foreign table.
- Each host row `i` is seeded to link foreign row `i` (identity permutation).
- With seed caching enabled both tables are named from `seedHash` and built
  once into the seed dump; seeded host record ids are persisted in the host
  table description. `seedReady` revalidates the link field type and that the
  sample link titles still match the seed permutation (a crashed run left at
  the update permutation fails this and rebuilds).

## Execute Phase

1. Verify seed link samples (`seedReady`).
2. Execute setup (not measured): scan the foreign table to map foreign titles
   to record ids.
3. Start the primary timer and `PATCH /api/table/{tableId}/record` with
   `fieldKeyType: "id"`, `typecast: false`, re-pointing every host row `i` to
   foreign row `((i-1)*7+3) % 1000 + 1`. Multiplier 7 is coprime with 1,000,
   so the new mapping is a permutation and no row keeps its seeded target.
4. Stop the primary timer after the update response and assert routing matches
   the requested V1/V2 engine.
5. Verify sample rows then full-scan all 1,000 rows; every link cell title must
   match the updated permutation.
6. Cleanup restores the link cells to the seed permutation on local
   single-database runs; isolated execute databases are discarded by teardown.

## Primary Metric

- `bulkUpdate1kLinkCellsMs`: elapsed time for the bulk link-update request
  only.

Sample verification is recorded separately as `verifyUpdatedMs`. Seeding, the
foreign id scan, and seed validation stay out of the primary metric.

## Verification

- The update response must contain 1,000 updated record ids.
- Sample rows and a full paged scan confirm every link cell resolves to the
  updated permutation target by its foreign primary title.

## Notes

The workload is sized at 1,000 link cells to match the link bulk-update scale
in `tasks/todo.md`. `maxMs` (12,000) is calibrated 2026-06-22 from CI
history (93 v1+v2 runs; p95 ~4.7s, worst ~5.2s), set to ~2x the worst observed
to catch a real ~2x regression without flaking on CI variance.
