---
owner: backend-v2
tags:
  - formula
  - computed
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# formula/10k-5-concurrent

## Goal

Measure concurrent creation of five formula fields on the same 10k-row table and
verify that all computed values become fully readable.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Source fields are the same as `formula/10k-calc`: `Title`, `A`, `B`, and `C`.
- Seed hash inputs should include the case id, `formula-table` runner kind,
  source field layout, `recordCount`, `batchSize`, numeric-sequence generator
  config, fixture version, and seed implementation code.

With seed caching enabled, this table is named from `seedHash` and reused across
engines and workflow runs. The runner rebuilds it only on a cache miss or failed
`sourceReady` validation.

## Execute Phase

1. Restore or build the 10k-row seed table.
2. Verify the source samples are readable before measuring formula work.
3. Concurrently create five formula fields:
   - `Total 1`: `({A} * {B}) + {C}`
   - `Total 2`: `{A} + {B} + {C}`
   - `Total 3`: `({A} * {C}) + {B}`
   - `Total 4`: `{A} + ({B} * {C})`
   - `Total 5`: `({A} * 3) + ({B} * 5) + ({C} * 7)`
4. Poll until sample rows are correct for all formulas.
5. Full scan all 10k records and verify every formula result for every row.
6. Clean up execute-only changes. On cached seeds, delete only the five formula
   fields and preserve the source table for the next run.

## Primary Metric

- `formulasFullReadyMs`: concurrent formula creation plus full readiness
  verification.

The metric is the sum of `formulasReady` and `fullFormulaScanReady`. It starts
after the 10k-row source table has passed `sourceReady`, includes concurrently
creating all five formula fields, polling configured sample rows until every
formula result is correct, and a paged full scan of all 10,000 rows. It does not
include table creation, seed record insertion, seed-cache restore/build, source
sample validation, or cleanup; those are diagnostic metrics such as
`createTableMs`, `seedRecordsMs`, `sourceReadyMs`, `seedRestoreMs`, and
`seedBuildMs`.

## Notes

This case is intentionally heavier than the single-formula case. It is useful
for checking contention in computed field scheduling and field creation paths.
