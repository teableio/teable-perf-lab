---
owner: backend-v2
tags:
  - field-convert
  - formula
  - computed
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# field-convert/10k-text-to-formula

## Goal

Catch regressions in converting a populated text column into a computed
formula field on a 10k-row grid — the complex conversion path that discards
old cell values and recomputes the whole column
(`PUT /table/{tableId}/field/{fieldId}/convert`, canary feature
`convertField`).

## Seed Phase

- Creates one temporary table in the e2e seed base with `Title`
  (singleLineText), `A`, `B`, `C` (number), and `Total` (singleLineText).
- Inserts 10,000 deterministic records in 1,000-record batches. Numeric
  values reuse the formula-table scheme (`A = n`, `B = (n % 97) + 1`,
  `C = n % 13`); `Total` is seeded with throwaway text that the conversion
  replaces.
- With seed caching enabled, the table is named from `seedHash` and the seed
  job builds it once into the seed dump. The measured conversion replaces the
  `Total` column with computed values, so the cache relies on the same
  contract as field-delete: CI execute jobs run on an isolated restored copy
  of the seed database and simply discard the mutated copy; local
  (non-isolated) runs delete the mutated table in cleanup so the next run
  reseeds it. A cache-hit fixture is revalidated (`seedReady` plus source
  field type) and rebuilt if a leftover converted column is detected.

## Execute Phase

1. Build the 10k-row seed table and verify seed samples plus row-count
   boundaries (`seedReady`).
2. Convert the `Total` text field to a formula field with the expression
   `({A} * {B}) + {C}` (same as `formula/10k-5-concurrent` Total 1; field
   names are compiled to field ids before the request). Capture
   `x-teable-v2*` routing headers and assert the response used the engine
   requested by `PERF_LAB_ENGINE`.
3. Poll sample rows (offsets 0 / 4,999 / 9,999) until each converted cell
   equals the locally computed `A * B + C` value.
4. Full scan all 10,000 rows (1,000 per page) and verify every computed value
   and row uniqueness.
5. Cleanup: on CI isolated execute databases the mutated seed copy is
   discarded with the database; otherwise the table is deleted because the
   converted column cannot be restored cheaply.

## Primary Metric

- `convertTextToFormulaReadyMs`: the convert request plus computed-value
  readiness.

The metric starts after `seedReady` passes and covers the convert API request,
sample polling until formula results appear, and the paged full scan of all
10,000 rows. Table creation, seeding, seed validation, and cleanup stay out of
it and are reported as diagnostic metrics (`createTableMs`, `seedRecordsMs`,
`maxSeedBatchMs`, `seedReadyMs`, `convertRequestMs`,
`convertedSamplesReadyMs`, `convertedFullScanReadyMs`).

## Notes

This is intentionally heavier than the select-to-text case: the conversion
must type-change the column and backfill 10,000 computed values, exercising
the formula calculation path on top of the convert path. Initial `maxMs`
(15,000) is a wide guardrail picked relative to the 10k formula cases;
tighten it after real V1/V2 run history.
