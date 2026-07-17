---
owner: backend-v2
tags: [record-read, get-records, filter, text, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-filter-text-not-empty

## Goal

Measure the overhead of a match-all non-empty text filter on a 10,000-row read
that projects 50 stored and computed fields.

## Seed Phase

Reuse the deterministic record-read fixture: 10,000 source rows, 10,000 host
rows, 20 text fields, 5 formulas, 20 conditional lookups, and a fully verified
50-field projection. The query config is excluded from the seed hash so sibling
cases restore the same ready fixture.

## Execute Phase

Run ten unqueried 1,000-row pages as the warmed baseline, then run ten pages
with `Text 1 isNotEmpty`. Assert the requested engine route on every request.

## Primary Metric

`getRecordsQueryOverheadMs` is queried scan time minus baseline scan time,
clamped at zero. Initial guardrail: 8,000 ms.

## Notes

The query must return exactly 10,000 distinct rows. Every projected value is
checked, so a match-all predicate cannot pass by silently dropping rows.
