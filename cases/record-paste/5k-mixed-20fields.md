---
owner: backend-v2
tags: [record-paste, 5k, field-matrix, mixed, v1-v2]
enabled: true
---

# record-paste/5k-mixed-20fields

## Goal

Scale the 1k mixed paste baseline to one 5,000-row request while preserving its
20-field stored-value mix.

## Seed Phase

Create an empty 20-field mixed table and prepare a deterministic 5,000 x 20
clipboard payload before measurement.

## Execute Phase

Paste all 5,000 rows once and assert the engine-specific paste route.

## Primary Metric

- `paste5kMs`: paste request time only; initial `maxMs` is 30,000.

## Verification

Scan all 5,000 rows and verify every stored field at rows 1, 2,500, and 5,000.

## Notes

Compared with `record-paste/1k-mixed-20fields`, only row count changes.
