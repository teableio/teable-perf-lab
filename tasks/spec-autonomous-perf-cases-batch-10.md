# Autonomous Perf Cases — Batch 10

Status: approved by standing user authorization on 2026-07-18. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, then calibrate the initial threshold against official CI artifacts.

## Batch Goal

Add a scalar field-type matrix for `createTable` requests that carry 1,000
inline records. Existing `table-create` coverage has one mixed 20-field/1k-row
case, which catches aggregate regressions but cannot identify the field type
responsible. The new matrix holds the row count at 1,000 and varies only the
schema, with a one-field lower bound and a 20-field text width comparison.

Reuse and extend the existing seedless `table-create` runner. Table creation,
field creation, and inline record insertion remain inside the single measured
`POST /api/base/{baseId}/table` request. Post-request reads and cleanup remain
outside the primary timer. Because this family creates its fixture during the
measured operation, the batch adds no reusable fixture and no seed-row work.

The runner extension must close an existing correctness gap: current inline
record verification scans all rows but checks values only for two
single-line-text fields. Add opt-in verification config so every new case scans
all 1,000 rows, compares every configured field with its deterministic native
input value, and records rows 1, 500, and 1,000 as artifact samples. Preserve
the existing cases' behavior unless they opt in.

All cases use `createTable1x1kRecordsMs`. The initial 8-second assumption was
calibrated after the first official V1/V2 run: all 20 artifacts passed at
436.45-2,123.38 ms. The primary-only and ten-field cases now use `maxMs: 4_000`
(about 2.5x the ten-field worst), while the 20-field text case uses
`maxMs: 6_000` (about 2.8x its observed worst).

## Cases

1. `table-create/1x-1f-1k-primary-only`: one primary text field; the narrowest
   inline-create lower bound.
2. `table-create/1x-10f-1k-single-line-text`: primary plus nine single-line
   text fields; isolate plain text insertion at fixed width.
3. `table-create/1x-10f-1k-long-text`: primary plus nine long-text fields;
   isolate long-text payload insertion.
4. `table-create/1x-10f-1k-number`: primary plus nine number fields; isolate
   native numeric insertion.
5. `table-create/1x-10f-1k-date`: primary plus nine UTC date fields; isolate
   native ISO date insertion and normalization.
6. `table-create/1x-10f-1k-checkbox`: primary plus nine checkbox fields;
   isolate alternating checked/empty values.
7. `table-create/1x-10f-1k-single-select`: primary plus nine fields cycling
   three fixed choices; isolate option resolution.
8. `table-create/1x-10f-1k-multiple-select`: primary plus nine fields cycling
   four fixed choices; isolate native array insertion.
9. `table-create/1x-10f-1k-rating`: primary plus nine five-star rating fields;
   isolate bounded numeric rating insertion.
10. `table-create/1x-20f-1k-single-line-text`: primary plus nineteen text
    fields; compare schema/payload width without mixed-type effects.

## Shared Contract

- **Runner**: `table-create`.
- **Seed Phase**: none; `perf:seed` must report skipped.
- **Execute Phase**: one measured create-table request carrying the configured
  schema and 1,000 deterministic inline records.
- **Primary Metric**: `createTable1x1kRecordsMs`; `maxMs: 4_000` for the
  primary-only/ten-field cases and `maxMs: 6_000` for the 20-field text case.
- **Routing**: require `x-teable-v2-feature: createTable` and the requested V1
  or V2 engine.
- **Verification**: exact field count, at least one view, full scan of 1,000
  rows, exact values in every configured field, and artifact samples for row
  offsets 0, 499, and 999.
- **Cleanup**: permanently delete the created table outside isolated execute
  jobs.

## Explicit Rejections

- Do not add another mixed 20-field/1k-row case; the existing
  `table-create/1x-20f-1k-records` already provides that control.
- Do not use `selection-clear` for this batch. Its ten new reusable fixtures
  would increase the known slow seed workload, while table-create is seedless.
- Do not put verification or cleanup inside the primary metric.
- Do not accept row count alone; typed values must be checked across the full
  scan.
- Do not use computed, link, attachment, or user fields. Those require
  dependency setup or non-native values and would stop being a controlled
  scalar matrix.
