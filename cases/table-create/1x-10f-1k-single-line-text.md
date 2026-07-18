---
owner: perf-lab
tags: [table-create, records, text]
enabled: true
---

# table-create/1x-10f-1k-single-line-text

## Goal

Isolate plain-text inline insertion by creating one ten-field text table with
1,000 records in the measured `createTable` request.

## Seed Phase

None. The case is seedless and creates its table during execution.

## Execute Phase

Create `Title` plus nine text fields with 10,000 deterministic text cells.
After timing, scan all 1,000 rows, compare all ten values per row, preserve
three fixed samples, assert routing, and delete the table.

## Primary Metric

- `createTable1x1kRecordsMs`: request wall time, calibrated maximum 4,000 ms.

## Notes

Compare with the primary-only case to expose payload-width cost without
typecasting differences.
The shared ten-field guardrail retains about 2.5x headroom over the first
official matrix worst sample (1,605.87 ms).
