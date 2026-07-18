---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - rating
  - v1-v2
enabled: true
---

# record-paste/1k-rating-10fields

## Goal

Measure bounded rating typecasting while grid-pasting 1,000 records into a
fixed-width ten-field table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine five-star rating
  fields and builds the deterministic 1,000 × 10 TSV before measurement.

## Execute Phase

1. Paste rating values cycling from 1 through 5.
2. Assert the response status, response shape, and requested engine route.
3. Stop the timer, then full scan all 1,000 rows and compare every rating.
4. Preserve exact samples for rows 1, 500, and 1,000 and delete the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  calibrated guardrail `maxMs: 6_000`.

## Notes

All rating fields share the same deterministic five-star configuration.
Verification and cleanup are outside the metric. V1 uses range paste; V2 uses
paste-by-id.
