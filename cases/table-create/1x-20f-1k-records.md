---
owner: perf-lab
tags:
  - table-create
  - tables
  - data-scaling
enabled: true
---

# table-create/1x-20f-1k-records

## Goal

The data-scaling variant of `createTable`: create one mixed 20-field table
whose `POST /api/base/{baseId}/table` request body carries **1,000 inline
records**, so the measured cost includes the record insertion that the
no-records variant deliberately excludes.

## Seed Phase

None (`pnpm perf:seed` reports skipped). The measured request itself creates
the table; nothing is reused between runs.

## Execute Phase

1. Measured (`createTablesTotal`, single `createTable-01` step): one
   `POST /api/base/{baseId}/table` with the mixed 20-field schema and 1,000
   deterministic inline records. Inline values are generated natively valid
   per field type (full ISO datetimes, exact select choice names, checkbox
   `true`/omitted) because the create-table path performs **no typecast**,
   unlike the `createRecords` seeding API.
2. Routing headers are recorded (`x-teable-v2-feature: createTable`), and V1/V2
   runs fail if the response did not use the requested engine.
3. Verify: field count and view presence, a paged scan proving exactly 1,000
   records exist, and first/last-row sample checks on two text fields.
4. Cleanup permanently deletes the created table.

## Primary Metric

- `createTable1x1kRecordsMs`: wall time of the measured create window
  (single request incl. inline record insertion).

## Verification Metrics

- `createTableMinMs` / `createTableP50Ms` / `createTableP95Ms` /
  `createTableMaxMs`: per-request distribution (single sample here).
- `createTablesVerifyMs`: post-create verification duration (diagnostic).

## Notes

- Companion of `table-create/10x-20f-no-records`: same schema, zero vs 1,000
  inline records — the difference isolates the record-dependent share of
  createTable.
- Checkbox cells are seeded as `true` or omitted (never `false`) and Date
  cells as full ISO strings, because inline records skip typecast on both
  engines.
