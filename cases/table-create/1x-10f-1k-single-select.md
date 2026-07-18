---
owner: perf-lab
tags: [table-create, records, single-select]
enabled: true
---

# table-create/1x-10f-1k-single-select

## Goal

Isolate single-select option resolution during table creation with 1,000
inline records.

## Seed Phase

None. The field options and records are part of the measured request.

## Execute Phase

Create `Title` plus nine single-select fields cycling through three fixed choice
names. After timing, full-scan and compare every resolved name, retain three
samples, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, initial maximum 8,000 ms.

## Notes

Choice names are exact native values; no option creation or typecast is allowed
after the request starts.
