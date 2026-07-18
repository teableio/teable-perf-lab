---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - mixed-fields
  - v1-v2
enabled: true
---

# record-paste/1k-mixed-20fields

## Goal

Measure a bounded 1,000-row grid paste across the established 20-field mixed
scalar schema.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty 20-field table containing text, long text,
  selects, numbers, dates, checkboxes, and ratings.
- It builds the deterministic 1,000 × 20 TSV before the primary timer.

## Execute Phase

1. Paste the 20,000-cell mixed clipboard block into the empty table.
2. Assert the response status, response shape, and V1/V2 route.
3. Stop the timer, then full scan all 1,000 rows and compare all twenty cells.
4. Preserve exact samples for rows 1, 500, and 1,000 and delete the table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  calibrated guardrail `maxMs: 6_000`.

## Notes

This is the bounded comparison for the existing 10k mixed paste case. The
schema is fixed so later regressions can be compared across bulk create, update,
duplicate, and paste behaviors. Verification and cleanup are outside the timer.
V1 uses range paste; V2 uses paste-by-id.
