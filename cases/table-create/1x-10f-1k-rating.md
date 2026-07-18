---
owner: perf-lab
tags: [table-create, records, rating]
enabled: true
---

# table-create/1x-10f-1k-rating

## Goal

Isolate bounded rating insertion in a ten-field table created with 1,000
inline records.

## Seed Phase

None. The measured request creates all fields and rows.

## Execute Phase

Create `Title` plus nine five-star rating fields cycling through values 1-5.
After timing, full-scan and compare every rating, retain three fixed samples,
assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, calibrated maximum 4,000 ms.

## Notes

The number case is the same-width unbounded numeric control.
The guardrail is calibrated from the first official V1/V2 matrix run, whose
ten-field worst sample was 1,605.87 ms.
