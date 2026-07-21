---
owner: backend-v2
tags: [record-paste, 5k, field-matrix, checkbox, v1-v2]
enabled: true
---

# record-paste/5k-checkbox-10fields

## Goal

Scale the 1k checkbox paste baseline to one 5,000-row request while preserving
its ten-field table shape.

## Seed Phase

Create an empty table with `Title` plus nine checkbox fields and prepare a
deterministic 5,000 x 10 clipboard payload before measurement.

## Execute Phase

Paste all 5,000 rows once and assert the engine-specific paste route.

## Primary Metric

- `paste5kMs`: paste request time only; initial `maxMs` is 30,000.

## Verification

Scan all 5,000 rows and verify rows 1, 2,500, and 5,000, including blank
checkbox cells.

## Notes

Compared with `record-paste/1k-checkbox-10fields`, only row count changes.
