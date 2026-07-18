---
owner: backend-v2
tags:
  - field-duplicate
  - rollup
  - link
  - computed
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-rollup-field

## Goal

Measure duplicating a ready Rollup over 10,000 populated many-many Link edges
and waiting until every copied aggregate is readable.

## Seed Phase

- Creates 10,000 foreign rows with deterministic numeric `Amount = row * 7 + 3`.
- Creates 10,000 host rows; host row `n` links to foreign row `n`.
- Creates `Amount Sum = sum({values})` and full-scans the ready source Rollup.
- Reusable seeds keep the Link and source Rollup but remove stale copies.

## Execute Phase

1. Revalidate Link samples and all 10,000 source Rollup values.
2. Duplicate `Amount Sum` to `Amount Sum Copy` through the public endpoint.
3. Require the requested engine and `x-teable-v2-feature: duplicateField`.
4. Verify the Rollup expression and foreign/link/value dependencies are
   preserved without adding unrelated fields.
5. Full-scan 10,000 host rows and prove both fields equal the locally derived
   foreign amount, including offsets 0, 4,999, and 9,999.

## Primary Metric

- `computedFieldDuplicateReadyMs`: duplicate request time plus copied Rollup
  full-readiness time. Fixture construction and source readiness are excluded.

## Notes

The one-edge-per-host shape isolates duplicate and recompute cost from fanout.
The 15-second guardrail was calibrated from official CI runs `29652244869`,
`29653349659`, and `29653754982`: valid V1 samples ranged from 2,465.84 ms to
2,602.71 ms, while successful V2 samples measured 5,122.17 ms and 6,670.72 ms.
The bound leaves about 2.25x headroom over the observed worst while protecting
request plus full readiness.
