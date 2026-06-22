---
owner: backend-v2
tags:
  - field-convert
  - select
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# field-convert/10k-multi-select-to-text

## Goal

Catch regressions in converting a populated multiple select column to single
line text on a 10k-row grid — the standard field type conversion path that
rewrites every cell value of the column (`PUT /table/{tableId}/field/{fieldId}/convert`,
canary feature `convertField`).

## Seed Phase

- Creates one temporary table in the e2e seed base with `Title`
  (singleLineText) and `Tags` (multipleSelect with choices Alpha, Beta, Gamma,
  Delta).
- Inserts 10,000 deterministic records in 1,000-record batches. Row `n` gets
  `Tags = [choices[(n-1) % 4], choices[n % 4]]`, so every row holds two
  distinct choices computable from the row number.
- With seed caching enabled, the table is named from `seedHash` and the seed
  job builds it once into the seed dump. The measured conversion rewrites the
  `Tags` column in place, so the cache relies on the same contract as
  field-delete: CI execute jobs run on an isolated restored copy of the seed
  database and simply discard the mutated copy; local (non-isolated) runs
  delete the mutated table in cleanup so the next run reseeds it. A cache-hit
  fixture is revalidated (`seedReady` plus source field type) and rebuilt if a
  leftover converted column is detected.

## Execute Phase

1. Build the 10k-row seed table and verify seed samples plus row-count
   boundaries (`seedReady`).
2. Convert the `Tags` field to `singleLineText` through the field convert
   endpoint. Capture `x-teable-v2*` routing headers and assert the response
   used the engine requested by `PERF_LAB_ENGINE`.
3. Poll sample rows (offsets 0 / 4,999 / 9,999) until each converted cell
   equals the locally computed `choices.join(", ")` text (e.g. `"Alpha, Beta"`).
4. Full scan all 10,000 rows (1,000 per page) and verify every converted cell
   value and row uniqueness.
5. Cleanup: on CI isolated execute databases the mutated seed copy is
   discarded with the database; otherwise the table is deleted because the
   converted column cannot be restored cheaply.

## Primary Metric

- `convertSelectToTextReadyMs`: the convert request plus converted-value
  readiness.

The metric starts after `seedReady` passes and covers the convert API request,
sample polling until converted text appears, and the paged full scan of all
10,000 rows. Table creation, seeding, seed validation, and cleanup stay out of
it and are reported as diagnostic metrics (`createTableMs`, `seedRecordsMs`,
`maxSeedBatchMs`, `seedReadyMs`, `convertRequestMs`,
`convertedSamplesReadyMs`, `convertedFullScanReadyMs`).

## Notes

`maxMs` (6,000) is calibrated 2026-06-22 from CI history (158 v1+v2 runs; p95
~2.6s, worst ~2.9s), set to ~2x the worst observed to catch a real ~2x
regression without flaking on CI variance. Expected text uses the product's multiple-select
`cellValue2String` semantics (`values.join(", ")`).
