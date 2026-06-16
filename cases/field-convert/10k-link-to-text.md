---
owner: backend-v2
tags:
  - field-convert
  - link
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# field-convert/10k-link-to-text

## Goal

Catch regressions in converting a populated many-one link field into single
line text on a 10k-row grid — the conversion that breaks link semantics and
freezes the linked display titles into plain text across every row.

This drives the `convertField` canary path through
`PUT /table/{tableId}/field/{fieldId}/convert`.

## Seed Phase

- Creates a foreign table of 1,000 rows whose primary `Key` titles are
  `fk-<paddedRow>`, and a 10k-row host table with `Title` plus a one-way
  many-one `Linked` field pointing at the foreign table.
- Host row `n` links foreign row `((n-1)*7) % 1000 + 1`. Multiplier 7 is
  coprime with 1,000, so the 10k host rows spread evenly over the 1k foreign
  titles, and each row's expected link title is computable from the row number.
- With seed caching enabled both tables are named from `seedHash` and built
  once into the seed dump. Because the conversion rewrites the source column in
  place, the cache uses the field-delete contract: CI execute jobs run on an
  isolated restored copy and discard it; local runs delete both fixture tables
  so the next run reseeds. A cache hit is revalidated (`seedReady` plus source
  field type) and rebuilt if a leftover converted column is detected.

## Execute Phase

1. Build the fixtures and verify seed link samples plus row-count boundaries
   (`seedReady`).
2. Convert the `Linked` field to `singleLineText` through the field convert
   endpoint. Capture `x-teable-v2*` routing headers and assert the response
   used the engine requested by `PERF_LAB_ENGINE`.
3. Poll sample rows (offsets 0 / 4,999 / 9,999) until each converted cell
   equals the locally computed foreign title (e.g. `fk-000007`).
4. Full scan all 10,000 rows (1,000 per page) and verify every converted text
   value and row uniqueness.
5. Cleanup: isolated CI execute databases are discarded; local runs delete the
   host and foreign tables because the converted column cannot be restored
   cheaply.

## Primary Metric

- `convertLinkToTextReadyMs`: the convert request plus converted-value
  readiness.

The metric starts after `seedReady` and covers the convert API request, sample
polling until the frozen titles appear, and the paged full scan of all 10,000
rows. Table creation, seeding, seed validation, and cleanup stay out of it and
are reported as diagnostics (`createTableMs`, `seedRecordsMs`, `maxSeedBatchMs`,
`seedReadyMs`, `convertRequestMs`, `convertedSamplesReadyMs`,
`convertedFullScanReadyMs`).

## Notes

The expected text equals the link's display title (the foreign primary `Key`).
Initial `maxMs` (30,000) is a wide guardrail relative to the existing 10k
convert cases; tighten it after real V1/V2 run history.
