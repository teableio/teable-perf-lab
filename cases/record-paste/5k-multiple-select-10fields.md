---
owner: backend-v2
tags: [record-paste, paste, 5k, field-matrix, multiple-select, scale-up, v1-v2]
enabled: true
---

# record-paste/5k-multiple-select-10fields

## Goal

Measure one 5,000-row clipboard paste into a fixed-width ten-field multiple-select table.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine multiple-select fields and builds a deterministic 5,000 × 10 TSV payload.

## Execute Phase

1. Paste the 50,000-cell block in one operation and assert V1/V2 routing.
2. Stop the timer, full scan all 5,000 rows, normalize option arrays, verify rows 1, 2,500, and 5,000, then delete the table.

## Primary Metric

- `paste5kMs`: paste request and response assertions; initial guardrail `maxMs: 30_000`.

## Notes

This scales only row/request volume from the 1k sibling; schema and generator stay fixed. Full-scan verification and cleanup are outside the metric.
