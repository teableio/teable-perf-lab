---
owner: perf-lab
tags:
  - table-delete
  - tables
  - links
  - data-scaling
enabled: true
---

# table-delete/10k-20f-link-detach

## Goal

The data-scaling path of `deleteTable`: archive a small foreign table while a
10,000-record mixed 20-field table still links to it.

On v1, soft delete runs `detachLink` first, which converts the surviving
table's link field to single-line text via a full field conversion — a
cell-by-cell rewrite that is **O(rows of the surviving table)** and happens
inside the measured delete request. On v2, soft delete skips cross-table side
effects entirely (they only run for permanent deletes), so the same request is
a metadata flip. This case records both the latency gap and the behavioral
difference.

## Seed Phase

Per sample (3 samples, each with its own seed-cache identity):

1. Create a foreign table (`<seed-name>-fk`, 1,000 rows, `Key` / `Note`).
2. Create the main table: mixed 20-field schema (`undoRedo10kBaseConfig`) plus
   a one-way `Ref Link` field; 10,000 records, row _i_ linking to foreign row
   `((i - 1) * 7 + 3) % 1000 + 1`.

The sample count stays small because a v1 run destroys the fixture (the link
field is converted to text), forcing a full reseed of
3 × (10,000 + 1,000) records on the next run.

## Execute Phase

1. Measured per sample (`deleteTableDetachLink-sample-*`):
   `DELETE /api/base/{baseId}/table/{foreignTableId}` with routing headers
   recorded (`x-teable-v2-feature: deleteTable`), and V1/V2 runs fail if the
   response did not use the requested engine.
2. Verify per sample: the foreign table left the base table list, its trash
   item exists, the main table still serves all 10,000 rows, and the surviving
   link field's post-delete state is recorded (v1: `singleLineText`,
   v2: still `link`) — recorded as evidence, not asserted per engine.
3. Cleanup per sample: restore the foreign table from trash, then re-validate
   the pair. Intact pairs (v2 path) are kept as reusable seeds; detached pairs
   (v1 path) are permanently deleted.

## Primary Metric

- `deleteTableDetachLinkP95Ms`: p95 latency of the 3 measured delete requests.
  Expected: seconds on v1 (field conversion over 10k cells), tens of ms on v2.

## Verification Metrics

- `deleteTableMinMs` / `deleteTableP50Ms` / `deleteTableMaxMs` /
  `deleteTableTotalMs`: request distribution (diagnostic).
- `verifyMs`: table-list/trash checks plus the main-table full scan.
  Diagnostic only.

## Notes

- Companion of `table-delete/10k-20f`, which deletes a table nobody links to
  and is therefore record-count independent on both engines.
- The v1/v2 results are **not directly comparable**: v1 pays the detach cost
  inside the request, while v2 defers nothing — it simply does not detach on
  soft delete. The case doubles as a marker of that semantic difference
  (after a v2 soft delete the surviving link field still points at a trashed
  table).
- The threshold (10 s) was calibrated from local 2026-06-12 verification:
  v1 p95 ~1.1–1.3 s (detachLink conversion), v2 p95 ~23–41 ms. It guards the
  v1 conversion path against order-of-magnitude regressions while leaving the
  expected engine gap unasserted.
