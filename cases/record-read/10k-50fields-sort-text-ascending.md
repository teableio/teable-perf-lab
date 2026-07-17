---
owner: backend-v2
tags: [record-read, get-records, sort, text, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-sort-text-ascending

## Goal

Measure ascending text sorting across a 10,000-row read with 50 projected
stored and computed fields.

## Seed Phase

Reuse the shared record-read fixture. `Text 1` contains unique, padded,
deterministic values so lexical ordering is stable across engines.

## Execute Phase

Run the unqueried baseline, then scan ten pages with `orderBy Text 1 asc`.

## Primary Metric

`getRecordsQueryOverheadMs`, queried duration minus baseline duration clamped
at zero. Initial guardrail: 8,000 ms.

## Notes

The runner requires all 10,000 distinct rows, nondecreasing `Text 1`, complete
50-field value correctness, and matched routing for every page.
