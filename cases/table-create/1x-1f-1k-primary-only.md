---
owner: perf-lab
tags: [table-create, records, primary-field]
enabled: true
---

# table-create/1x-1f-1k-primary-only

## Goal

Establish the narrowest `createTable` baseline by creating one primary-only
table with 1,000 inline records in the measured request.

## Seed Phase

None. The measured request creates the table and records from scratch.

## Execute Phase

Send one routed `POST /api/base/{baseId}/table` with one text field and 1,000
deterministic titles. After timing, scan all rows, compare every title, record
rows 1/500/1,000 as evidence, then delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: create-table request wall time, calibrated maximum
  4,000 ms.

## Notes

This is the lower bound for the wider and typed inline-record variants.
The 4-second guardrail retains more than 6x headroom over the first official
V1/V2 worst sample (611.08 ms).
