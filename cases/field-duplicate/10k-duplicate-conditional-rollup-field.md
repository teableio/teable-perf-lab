---
owner: backend-v2
tags:
  - field-duplicate
  - conditional-rollup
  - computed
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-conditional-rollup-field

## Goal

Measure duplicating a ready Conditional Rollup over a 10,000-by-10,000
unique-key match and waiting until the copy is correct across every host row.

## Seed Phase

- Creates 10,000 deterministic source rows and 10,000 host rows.
- A permutation with multiplier 73 and offset 19 gives every host row one
  distinct source match.
- Creates `Joined A Value = array_join({values})` with limit 1 and full-scans
  the source field before execute begins.

## Execute Phase

1. Revalidate both seed tables and all source Conditional Rollup values.
2. Duplicate `Joined A Value` to `Joined A Value Copy`.
3. Require the requested engine and `x-teable-v2-feature: duplicateField`.
4. Verify type, expression, foreign table, value field, filter, limit, and field
   count metadata.
5. Full-scan 10,000 rows and prove source and copy equal the locally derived
   permuted source value, including offsets 0, 4,999, and 9,999.

## Primary Metric

- `computedFieldDuplicateReadyMs`: duplicate request time plus copied
  Conditional Rollup full-readiness time. Seed and source readiness are excluded.

## Notes

The initial 120-second bound is a safety ceiling pending official V1/V2 CI
calibration.
