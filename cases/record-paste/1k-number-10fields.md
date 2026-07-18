---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - number
  - v1-v2
enabled: true
---

# record-paste/1k-number-10fields

## Goal

Measure numeric clipboard parsing and grid paste insertion for 1,000 records in
a fixed-width ten-field table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine number fields and
  builds a deterministic 1,000 × 10 TSV payload before measurement.

## Execute Phase

1. Paste the mixed title/numeric block into the empty table.
2. Assert the response status, response shape, and V1/V2 route.
3. Stop the timer, then full scan all 1,000 rows and normalize every number.
4. Verify rows 1, 500, and 1,000 explicitly, then delete the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  initial guardrail `maxMs: 15_000`.

## Notes

Holding nine numeric columns constant isolates typecast work from table width.
Full-scan verification and cleanup are outside the metric. V1 uses range paste;
V2 uses paste-by-id.
