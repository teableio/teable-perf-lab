---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - v1-v2
enabled: true
---

# record-paste/1k-primary-only

## Goal

Measure the lower-bound grid paste path for inserting 1,000 records into an
empty primary-only table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates one empty scratch table containing only `Title` and
  builds a deterministic 1,000-row TSV payload.
- Table creation and payload construction finish before the primary timer.

## Execute Phase

1. Paste 1,000 deterministic titles into the empty table.
2. Assert the response status, response shape, and requested V1/V2 route.
3. Stop the primary timer when the paste response has been validated.
4. Full scan all 1,000 created records and verify every title.
5. Record exact evidence for rows 1, 500, and 1,000, then delete the table.

## Primary Metric

- `paste1kMs`: elapsed time for the single paste request and its response
  assertions; calibrated guardrail `maxMs: 6_000`.

## Notes

V1 uses range paste and V2 uses paste-by-id, matching each engine's grid
behavior. Both legs paste the same TSV content and share the same full-scan
verification. The threshold was calibrated from the first official V1/V2 run.
