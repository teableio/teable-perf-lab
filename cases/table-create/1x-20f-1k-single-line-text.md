---
owner: perf-lab
tags: [table-create, records, text, width-scaling]
enabled: true
---

# table-create/1x-20f-1k-single-line-text

## Goal

Measure schema and inline-payload width by creating one 20-field text table
with 1,000 records in a single `createTable` request.

## Seed Phase

None. The case adds no reusable seed work.

## Execute Phase

Create `Title` plus nineteen text fields with 20,000 deterministic cells.
Outside the timer, full-scan and compare all values, capture rows 1/500/1,000,
assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, initial maximum 8,000 ms.

## Notes

Compare with the ten-field text case for width scaling and the existing mixed
20-field case for type-mix cost.
