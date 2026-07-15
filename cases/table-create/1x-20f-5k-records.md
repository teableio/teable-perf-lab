---
owner: perf-lab
tags:
  - table-create
  - tables
  - data-scaling
enabled: true
---

# table-create/1x-20f-5k-records

## Goal

Scale `table-create/1x-20f-1k-records` by 5x: create one mixed 20-field
table whose measured request carries 5,000 deterministic inline records.

## Seed Phase

None. The measured request creates the table and records together.

## Execute Phase

1. Send one measured `POST /api/base/{baseId}/table` request with the mixed
   20-field schema and 5,000 deterministic inline records.
2. Assert the routing headers match the requested V1/V2 engine.
3. Full-scan the created table and verify the record count and deterministic
   first/last-row samples.
4. Permanently delete the table during cleanup.

## Primary Metric

- `createTable1x5kRecordsMs`: wall time of the single create-table request,
  including inline record insertion.

## Verification Metrics

- `createTableMinMs` / `createTableP50Ms` / `createTableP95Ms` /
  `createTableMaxMs`: the single-request distribution.
- `createTablesVerifyMs`: post-create full-scan verification time.

## Notes

- This is a scale variant, not a replacement for the 1k baseline.
- The initial 30,000 ms threshold is deliberately loose until CI history is
  available for calibration.
