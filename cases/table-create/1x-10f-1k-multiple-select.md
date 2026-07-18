---
owner: perf-lab
tags: [table-create, records, multiple-select]
enabled: true
---

# table-create/1x-10f-1k-multiple-select

## Goal

Isolate native multiple-select array insertion during table creation with 1,000
inline records.

## Seed Phase

None. The field options and records are created in the measured request.

## Execute Phase

Create `Title` plus nine multiple-select fields cycling through four fixed
choices. Outside the timer, full-scan and compare every ordered value array,
capture three samples, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, calibrated maximum 4,000 ms.

## Notes

Each cell carries a one-choice array, avoiding clipboard parsing and isolating
the inline create-table path.
The guardrail is calibrated from the first official V1/V2 matrix run, whose
ten-field worst sample was 1,605.87 ms.
