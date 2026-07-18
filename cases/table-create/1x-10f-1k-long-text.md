---
owner: perf-lab
tags: [table-create, records, long-text]
enabled: true
---

# table-create/1x-10f-1k-long-text

## Goal

Isolate long-text inline insertion while holding the workload at one table,
ten fields, and 1,000 records.

## Seed Phase

None. The measured request creates all state from scratch.

## Execute Phase

Create `Title` plus nine long-text fields with deterministic native string
values. Outside the timer, full-scan all 10,000 cells, capture rows
1/500/1,000, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, calibrated maximum 4,000 ms.

## Notes

The ten-field text case is the same-width plain-text control.
The guardrail is calibrated from the first official V1/V2 matrix run, whose
ten-field worst sample was 1,605.87 ms.
