---
owner: backend-v2
tags:
  - formula
  - computed
  - 10k
  - v1-v2
enabled: true
---

# formula/10k-calc

## Goal

Measure how long it takes to create one formula field on a 10k-row table and
make the computed values fully readable.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Source fields:
  - `Title`: `Formula row <n>`
  - `A`: row number
  - `B`: `(rowNumber % 97) + 1`
  - `C`: `rowNumber % 13`
- Seed hash inputs should include the case id, `formula-table` runner kind,
  source field layout, `recordCount`, `batchSize`, numeric-sequence generator
  config, fixture version, and seed implementation code.

The current runner cold-builds this seed table and deletes it after the run.
When seed artifact caching is enabled, this phase should be restored by
`seedHash` and only rebuilt on a cache miss or failed `seedReady` validation.

## Execute Phase

1. Restore or build the 10k-row seed table.
2. Verify the source samples are readable before measuring formula work.
3. Create formula field `Total` with `({A} * {B}) + {C}`.
4. Poll until sample rows are correct.
5. Full scan all 10k records and verify the formula result for every row.
6. Clean up execute-only changes. Until seed caching exists, the current runner
   deletes the temporary table as part of cleanup.

## Primary Metric

- `formulaFullReadyMs`: formula field creation plus full readiness verification.

## Notes

This case focuses on single-formula computed readiness. If it regresses, compare
`createFormula:*` and `fullFormulaScanReady` phases to see whether the cost is in
field creation or result availability.
