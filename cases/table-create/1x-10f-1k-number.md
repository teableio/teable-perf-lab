---
owner: perf-lab
tags: [table-create, records, number]
enabled: true
---

# table-create/1x-10f-1k-number

## Goal

Isolate native numeric insertion in a `createTable` request carrying 1,000
inline records.

## Seed Phase

None. The table and rows are created by the measured request.

## Execute Phase

Create `Title` plus nine number fields whose values equal the deterministic row
number. After timing, full-scan and compare all values, retain three fixed
samples, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, calibrated maximum 4,000 ms.

## Notes

Inline records use native numbers; the create-table path performs no typecast.
The guardrail is calibrated from the first official V1/V2 matrix run, whose
ten-field worst sample was 1,605.87 ms.
