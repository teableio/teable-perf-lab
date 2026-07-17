---
owner: backend-v2
tags: [field-restore, checkbox, trash, 10k, v1-v2]
enabled: true
---

# field-restore/10k-active-field

## Goal

Measure restoring 10,000 alternating checkbox values, including unchecked/null
storage semantics.

## Seed Phase

Create `Title` plus `Active`; odd rows are checked and even rows are unchecked.

## Execute Phase

Delete `Active`, resolve its trash item, and measure the requested engine's
restore operation through completion.

## Primary Metric

- `restoreFieldMs` (initial guardrail: 120,000 ms).

## Verification

Assert routes and restored field identity, then scan every row. Checked rows
must be true; false and the product's equivalent null representation are
normalized only for unchecked rows.

## Notes

Checkbox nullability is a distinct V2 batch-restore correctness boundary.
