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

## Data Setup

- Creates one temporary table in the e2e seed base.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Source fields are the same as `formula/10k-calc`: `Title`, `A`, `B`, and `C`.

## Operation

1. Create a temporary table with `Title`, `A`, `B`, and `C`.
2. Insert 10k deterministic records.
3. Concurrently create five formula fields:
   - `Total 1`: `({A} * {B}) + {C}`
   - `Total 2`: `{A} + {B} + {C}`
   - `Total 3`: `({A} * {C}) + {B}`
   - `Total 4`: `{A} + ({B} * {C})`
   - `Total 5`: `({A} * 3) + ({B} * 5) + ({C} * 7)`
4. Poll until sample rows are correct for all formulas.
5. Full scan all 10k records and verify every formula result for every row.
6. Permanently delete the temporary table.

## Primary Metric

- `formulasFullReadyMs`: concurrent formula creation plus full readiness
  verification.

## Notes

This case is intentionally heavier than the single-formula case. It is useful
for checking contention in computed field scheduling and field creation paths.
