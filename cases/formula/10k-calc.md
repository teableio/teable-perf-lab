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

## Data Setup

- Creates one temporary table in the e2e seed base.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Source fields:
  - `Title`: `Formula row <n>`
  - `A`: row number
  - `B`: `(rowNumber % 97) + 1`
  - `C`: `rowNumber % 13`

## Operation

1. Create a temporary table with `Title`, `A`, `B`, and `C`.
2. Insert 10k deterministic records.
3. Create formula field `Total` with `({A} * {B}) + {C}`.
4. Poll until sample rows are correct.
5. Full scan all 10k records and verify the formula result for every row.
6. Permanently delete the temporary table.

## Primary Metric

- `formulaFullReadyMs`: formula field creation plus full readiness verification.

## Notes

This case focuses on single-formula computed readiness. If it regresses, compare
`createFormula:*` and `fullFormulaScanReady` phases to see whether the cost is in
field creation or result availability.
