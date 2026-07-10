---
owner: backend-v2
tags:
  - rollup
  - computed
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# rollup/conditional-10k

## Goal

Measure conditional rollup creation on two 10k-row tables where every host row
aggregates a different source row through a unique-key condition, paired with
`lookup/conditional-10k` for V1/V2 comparison.

## Seed Phase

- Reuses the deterministic source/host fixture shape owned by the conditional
  computed-field family.
- Creates source table A with 10,000 rows:
  - `A Key`: `A-Key-<n>`
  - `A Value`: `A-Value-<n>`
- Creates host table B with 10,000 rows:
  - `B Key`: `B-Key-<n>`
  - `Lookup A Key`: a permuted `A-Key-<n>`
- The multiplier `73` and offset `19` permutation maps each B row to exactly one
  distinct A row.
- The paired lookup and rollup cases use the same synthetic seed identity and
  seed-relevant config, so a selected pair can restore one source/host fixture.

## Execute Phase

1. Restore or build the two 10k-row seed tables.
2. Verify source and host samples before measuring.
3. Create conditional rollup field `Joined A Value` on B through the public
   create-field endpoint and assert that routing matches the requested engine.
4. Filter A where `A Key` equals the current B row's `Lookup A Key`, then apply
   `array_join({values})` to `A Value` with limit `1`.
5. Full scan all 10,000 B rows and verify every rollup result.
6. On a durable local database, delete the execute-created field and preserve
   the reusable source/host seed.

## Primary Metric

- `conditionalRollupReadyMs`: conditional rollup field creation plus full
  readiness verification.

The metric is the sum of `createRollupFieldMs` and
`fullRollupScanReadyMs`. Seed construction, cache restore, pre-operation seed
validation, and cleanup remain diagnostic phases outside the primary metric.

## Notes

- Compare this case with `lookup/conditional-10k`; both use the same row count,
  permutation, filter condition, source value, and readiness scan.
- `details.rollup.routing` records `x-teable-v2`,
  `x-teable-v2-feature=createField`, and `routeMatched` so a timing cannot pass
  under the wrong engine.
- The initial `maxMs` is aligned with the paired lookup guardrail and should be
  tightened after real V1/V2 CI history is available.
