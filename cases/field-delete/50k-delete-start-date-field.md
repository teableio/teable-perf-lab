---
owner: perf-lab
tags: [field-delete, date, scale-up, v1-v2]
enabled: true
---

# field-delete/50k-delete-start-date-field

## Goal

Measure deleting the populated `Start Date` field after scaling the affected table from 10,000 to 50,000 rows.

## Seed Phase

Create and validate a deterministic 50,000-row table containing `Title` and `Start Date`.

## Execute Phase

Delete only `Start Date`, assert V1/V2 field-delete routing, then scan all 50,000 surviving rows and verify the remaining schema.

## Primary Metric

- `deleteFieldMs`: field-delete request latency, initial maximum 10,000 ms.
