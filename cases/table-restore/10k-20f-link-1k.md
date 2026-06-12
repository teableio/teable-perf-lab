---
owner: perf-lab
tags:
  - table-restore
  - tables
  - links
  - data-scaling
enabled: true
---

# table-restore/10k-20f-link-1k

## Goal

Data-scaling sentinel for `restoreTable`: restore 5 independent 10,000-record
mixed 20-field tables that each own a **populated one-way link field** (10,000
link cells pointing at a 1,000-record foreign table).

Today both engines restore a table by flipping `deletedTime` on ~22 metadata
rows, so the measured latency is record-count independent (~tens of ms). This
case exists so that the moment restore gains record-dependent work — link
re-attachment, junction rebuilds, computed-field recompute, per-row triggers —
the p95 jumps from milliseconds to seconds and trips the threshold.

## Seed Phase

Per sample (5 samples, each with its own seed-cache identity):

1. Create a foreign table (`<seed-name>-fk`) with `Key` / `Note` text fields
   and 1,000 deterministic rows (`RESTORE-FK-00001` ...).
2. Create the main table with the shared mixed 20-field schema
   (`undoRedo10kBaseConfig`) plus a `Ref Link` field
   (`manyOne`, `isOneWay: true`, `foreignTableId` = the foreign table). One-way
   keeps the foreign table free of inbound link fields, so archiving the main
   table never triggers `detachLink` conversions and the fixture stays
   reusable.
3. Seed 10,000 records; row _i_ links to foreign row
   `((i - 1) * 7 + 3) % 1000 + 1`.

Seed validation: paged full row-count scan plus link-cell samples (offsets
0 / 4,999 / 9,999) proving each sampled cell resolves to the permuted foreign
`Key` title.

## Execute Phase

1. Setup per sample (not measured, `deleteSetup-*`): archive the main table,
   confirm it left the base table list, resolve its `trashId`.
2. Measured: 5 `POST /api/trash/restore/{trashId}` requests
   (`restoreTable-sample-*` steps) with routing headers recorded.
3. Verify per sample: paged 10,000-row full scan, `Title` / `External ID`
   sample text values, and link-cell samples proving the link data survived
   the archive/restore round trip.
4. A successful run leaves the fixtures restored and reusable; on failure
   cleanup retries the restore once and otherwise permanently deletes both
   tables of the pair.

## Primary Metric

- `restoreTableP95Ms`: historical p95 threshold key for the 5 measured restore
  requests. With 5 samples, the current nearest-rank percentile math makes this
  gate effectively the slowest request (max).

## Verification Metrics

- `restoreTableMinMs` / `restoreTableP50Ms` / `restoreTableMaxMs` /
  `restoreTableTotalMs`: request distribution (diagnostic).
  `restoreTableMaxMs` is expected to match `restoreTableP95Ms` while the case
  keeps 5 samples.
- `setupMs`: archive-to-trash setup duration across samples (diagnostic).
- `verifyMs`: full scans + text samples + link-cell samples. Diagnostic only.

## Notes

- Companion of `table-restore/10k-20f`: identical record volume, but the
  schema adds populated link cells — the dimension along which a future
  restore implementation is most likely to become O(records).
- The `isOneWay: true` link option is load-bearing: with a symmetric field,
  v1 archive of the main table would convert the foreign table's mirror link
  field and poison the fixture.
