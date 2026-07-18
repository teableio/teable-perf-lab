---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - multiple-select
  - v1-v2
enabled: true
---

# record-paste/1k-multiple-select-10fields

## Goal

Measure comma-delimited multi-select parsing and option resolution while
grid-pasting 1,000 records into a ten-field table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine multiple-select
  fields, each with four stable choices.
- It builds the deterministic two-choice TSV cells before measurement.

## Execute Phase

1. Paste the 1,000 × 10 clipboard block into the empty table.
2. Assert response status, response shape, and V1/V2 route.
3. Stop the timer, then full scan all records and normalize every choice array.
4. Verify rows 1, 500, and 1,000 explicitly, then clean up the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  initial guardrail `maxMs: 15_000`.

## Notes

The readback proves both option names and array ordering. Verification and
cleanup are outside the timer. V1 uses range paste; V2 uses paste-by-id.
