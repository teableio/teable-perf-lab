---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - single-select
  - v1-v2
enabled: true
---

# record-paste/1k-single-select-10fields

## Goal

Measure single-select option resolution while grid-pasting 1,000 records into a
fixed-width ten-field table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine single-select
  fields, each with the same three stable choices.
- It builds the deterministic 1,000 × 10 TSV before measurement.

## Execute Phase

1. Paste rows cycling through `Alpha`, `Beta`, and `Gamma`.
2. Assert response and requested V1/V2 route.
3. Stop the timer, then full scan all 1,000 records and compare every choice.
4. Preserve exact samples for rows 1, 500, and 1,000 and clean up the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  calibrated guardrail `maxMs: 6_000`.

## Notes

Keeping nine select columns at one width isolates option lookup/typecast cost.
Verification and cleanup are outside the timer. V1 uses range paste; V2 uses
paste-by-id.
