---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - checkbox
  - v1-v2
enabled: true
---

# record-paste/1k-checkbox-10fields

## Goal

Measure boolean and blank-cell typecasting while grid-pasting 1,000 records into
a fixed-width ten-field table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine checkbox fields
  and builds a deterministic 1,000 × 10 TSV before measurement.

## Execute Phase

1. Paste alternating checked and blank checkbox values into the table.
2. Assert the response status, response shape, and V1/V2 route.
3. Stop the timer, then full scan all 1,000 rows and compare boolean/null state.
4. Verify rows 1, 500, and 1,000 explicitly, then delete the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  initial guardrail `maxMs: 15_000`.

## Notes

The pattern exercises both checked values and clipboard blanks. Verification
and cleanup are outside the primary metric. V1 uses range paste; V2 uses
paste-by-id.
