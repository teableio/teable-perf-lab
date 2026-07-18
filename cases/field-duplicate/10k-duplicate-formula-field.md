---
owner: backend-v2
tags:
  - field-duplicate
  - formula
  - computed
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-formula-field

## Goal

Measure duplicating an already-ready arithmetic Formula across 10,000 rows and
waiting until the copied Formula is correct everywhere.

## Seed Phase

- Creates 10,000 deterministic rows with `Title`, `A`, `B`, and `C`.
- Creates `Total = ({A} * {B}) + {C}` and full-scans all source values before
  execute begins.
- Keeps the source Formula in the reusable seed; stale duplicate fields are
  removed when the seed is restored.

## Execute Phase

1. Revalidate the source rows and all 10,000 source Formula values.
2. Duplicate `Total` to `Total Copy` through the public field endpoint.
3. Require the requested engine and `x-teable-v2-feature: duplicateField`.
4. Verify type, compiled expression, field count, and non-primary metadata.
5. Full-scan 10,000 rows and prove source and copy both equal the locally
   derived arithmetic value, including offsets 0, 4,999, and 9,999.

## Primary Metric

- `computedFieldDuplicateReadyMs`: duplicate request time plus copied Formula
  full-readiness time. Seed creation and source readiness are excluded.

## Notes

The 6-second guardrail was calibrated from official CI runs `29652244869` and
`29653349659`: valid V1 samples measured 2,406.80 ms and 2,347.99 ms, while the
successful V2 sample measured 1,018.43 ms. The bound leaves about 2.49x
headroom over the observed worst while protecting request plus full readiness.
