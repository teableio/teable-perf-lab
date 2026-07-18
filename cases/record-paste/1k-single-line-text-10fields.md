---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - text
  - v1-v2
enabled: true
---

# record-paste/1k-single-line-text-10fields

## Goal

Measure grid paste performance for 1,000 records in a fixed-width ten-field
single-line text table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine text fields and
  builds a deterministic 1,000 × 10 TSV payload before the primary timer.

## Execute Phase

1. Paste the 10,000-cell text block into the empty table.
2. Assert the response status, expanded response shape, and V1/V2 route.
3. Stop the timer, then full scan all 1,000 records and compare all ten cells.
4. Preserve exact samples for rows 1, 500, and 1,000 and clean up the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  initial guardrail `maxMs: 15_000`.

## Notes

This isolates clipboard string parsing and insertion while holding table width
constant with the other ten-field cases. Verification and cleanup are outside
the primary timer. V1 uses range paste; V2 uses paste-by-id.
