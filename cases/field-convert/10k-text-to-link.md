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

# field-convert/10k-text-to-link

## Goal

Catch regressions in converting a populated text field into a many-one link
field on a 10k-row grid — the reverse of `field-convert/10k-link-to-text`. It
turns text values that name foreign records into real linked records, stressing
text-title matching, link relationship creation, and relationship value
rewrite.

This drives the `convertField` canary path through
`PUT /table/{tableId}/field/{fieldId}/convert`.

## Seed Phase

- Creates a foreign table of 1,000 rows whose primary `Key` titles are
  `fk-<paddedRow>`, and a 10k-row host table with `Title` plus a single line
  text `RefTitle` field.
- Host row `n`'s `RefTitle` holds the foreign primary title for foreign row
  `((n-1)*7) % 1000 + 1`. Multiplier 7 is coprime with 1,000, so the 10k text
  values cycle deterministically through the 1k unique foreign titles, and each
  text value matches exactly one foreign record (no auto-create of missing
  titles is exercised).
- With seed caching enabled both tables are named from `seedHash` and built
  once into the seed dump. Because the conversion rewrites the source column in
  place, the cache uses the field-delete contract: CI execute jobs run on an
  isolated restored copy and discard it; local runs delete both fixture tables
  so the next run reseeds. A cache hit is revalidated (`seedReady` plus source
  field type) and rebuilt if a leftover converted column is detected.

## Execute Phase

1. Build the fixtures and verify seed text samples plus row-count boundaries
   (`seedReady`).
2. Convert the `RefTitle` text field to a one-way many-one link pointing at the
   foreign table (the foreign table id is injected into the convert request at
   run time). Capture `x-teable-v2*` routing headers and assert the engine.
3. Poll sample rows (offsets 0 / 4,999 / 9,999) until each converted link cell
   resolves to a foreign record whose title equals the original text value.
4. Full scan all 10,000 rows (1,000 per page) and verify every converted link
   cell has a foreign record id and the expected title, plus row uniqueness.
5. Cleanup: isolated CI execute databases are discarded; local runs delete the
   host and foreign tables because the converted column cannot be restored
   cheaply.

## Primary Metric

- `convertTextToLinkReadyMs`: the convert request plus converted-value
  readiness.

The metric starts after `seedReady` and covers the convert API request, sample
polling until the links resolve, and the paged full scan of all 10,000 rows.
Table creation, seeding, seed validation, and cleanup stay out of it and are
reported as diagnostics (`createTableMs`, `seedRecordsMs`, `maxSeedBatchMs`,
`seedReadyMs`, `convertRequestMs`, `convertedSamplesReadyMs`,
`convertedFullScanReadyMs`).

## Notes

Every host text value matches a deterministic unique foreign title, so the
conversion creates real links rather than testing missing-title behavior.
`maxMs` (20,000) is calibrated 2026-06-22 from CI history (94 v1+v2 runs; p95
~8.8s, worst ~9.3s), set to ~2x the worst observed to catch a real ~2x
regression without flaking on CI variance.
