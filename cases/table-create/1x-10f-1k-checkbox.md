---
owner: perf-lab
tags: [table-create, records, checkbox]
enabled: true
---

# table-create/1x-10f-1k-checkbox

## Goal

Isolate checkbox insertion in a ten-field table created with 1,000 inline
records.

## Seed Phase

None. The measured operation creates the fixture.

## Execute Phase

Create `Title` plus nine checkbox fields alternating checked and omitted cells.
After timing, full-scan all rows and fields, capture rows 1/500/1,000, assert
routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, initial maximum 8,000 ms.

## Notes

Unchecked values are omitted instead of sending `false`, matching the native
inline-create contract on both engines.
