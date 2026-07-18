---
owner: perf-lab
tags: [table-create, records, date]
enabled: true
---

# table-create/1x-10f-1k-date

## Goal

Isolate UTC date insertion and normalization in `createTable` with 1,000
inline records.

## Seed Phase

None. No reusable fixture is built.

## Execute Phase

Create `Title` plus nine UTC date fields cycling through deterministic 2026
instants. Outside the timer, full-scan all rows, compare normalized ISO values,
capture three samples, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, initial maximum 8,000 ms.

## Notes

Full ISO datetimes are supplied because inline create-table records skip
typecasting.
