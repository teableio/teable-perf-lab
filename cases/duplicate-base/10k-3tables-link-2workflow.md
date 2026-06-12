---
owner: perf-lab
tags:
  - duplicate-base
  - records
  - tables
enabled: true
---

# duplicate-base/10k-3tables-link-2workflow

## Goal

Measure duplicating a base that contains a 10,000-record mixed 20-field main
table, a 1,000-record table linked to it, a 100-record small table, and 2
workflows, with records included.

## Seed Phase

Create a dedicated source base in the seeded space (never the shared seed
base, which accumulates other cases' fixture tables and would make the
duplicated payload non-deterministic). Inside it:

- **Main 10k**: the shared mixed 20-field schema with 10,000 deterministic
  rows generated from the row number.
- **Linked 1k**: 1,000 rows with `Key`/`Note` text fields plus a many-one link
  field to the main table. Linked row `i` points at main row
  `((i - 1) * 7 + 3) % 10000 + 1`, so every link target is locally computable.
- **Small 100**: 100 rows with 3 text fields and a number field.
- **2 workflows** created via `POST /api/base/{baseId}/workflow`. Workflow
  creation is best-effort: the automation module is an EE feature, and the
  actually seeded count is persisted in the fixture metadata so verification
  expects exactly what exists.

The source base is reusable across runs when the seed cache is enabled; it is
discovered by name in the space base list and validated with full scans before
measurement.

## Execute Phase

1. Reuse or create the source base, full-scan validated.
2. Measured: `POST /api/base/duplicate` with `withRecords: true` and the
   seeded space as the target. Routing headers
   (`x-teable-v2-feature: duplicateBase`) are captured, and V1/V2 runs fail if
   the response did not use the requested engine.
3. Verify the duplicated base:
   - main table: paged full scan of all 10,000 rows plus sampled `Title` /
     `External ID` values;
   - linked table: the duplicated link field's `foreignTableId` must point at
     the duplicated main table (id-remap proof), all 1,000 rows scanned, and
     sampled link cells must resolve to records inside the duplicated main
     table with the expected titles;
   - small table: 100-row count scan;
   - workflows: the duplicated base must contain at least the seeded workflow
     count (skipped when the runtime has no automation module).
4. Cleanup permanently deletes the duplicated base; the source base stays
   cached.

## Primary Metric

- `duplicateBaseRequestMs`: the `POST /base/duplicate` request duration with
  `withRecords: true`, covering base/table/view/field structure duplication,
  record copy, and link id remapping until the API returns.

## Verification Metrics

- `duplicateBaseFullScanReadyMs`: post-response verification time (full scans,
  link remap proof, workflow count). Diagnostic only.
- `duplicateBaseTotalReadyMs`: request plus verification, kept as an
  end-to-end reference.

## Notes

- The synchronous `/base/duplicate` endpoint is measured, not the
  `/base/duplicate-stream` SSE variant.
- The cross-table link is what distinguishes this case from
  `duplicate-table/10k-20f`: base duplication must remap link field targets to
  the duplicated tables, which table duplication never exercises.
- No lookup/rollup fields through the link yet; a computed-field-heavy base is
  a candidate follow-up case.
- This case is inherently data-scaling already: the duplicate copies all
  11,100 records of the source base, so the primary metric grows with
  record volume by construction (unlike the metadata-only lifecycle
  operations, which need dedicated link/inline-record variants).
