---
owner: backend-v2
tags: [field-restore, single-line-text, trash, 10k, v1-v2]
enabled: true
---

# field-restore/10k-owner-text-field

## Goal

Measure restoring a populated single-line text field and its 10,000 cell values.

## Seed Phase

Create a narrow deterministic table containing only `Title` and `Owner Text`.
Row values are derived from the row number and inserted in 1,000-row batches.

## Execute Phase

Delete `Owner Text` as unmeasured setup, resolve its trash item, then measure V1
direct restore or the V2 restore-field stream through completion.

## Primary Metric

- `restoreFieldMs` (initial guardrail: 120,000 ms).

## Verification

Delete and restore routes must match the requested engine. The same field id and
name must reappear, and a full 10,000-row scan must match every generated value.

## Notes

The two-field fixture retains the full restored-cell count while avoiding the
unrelated 20-field mixed-table seed cost.
