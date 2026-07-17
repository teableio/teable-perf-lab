---
owner: backend-v2
tags: [field-restore, number, trash, 10k, v1-v2]
enabled: true
---

# field-restore/10k-amount-field

## Goal

Measure restoring a populated numeric column on 10,000 rows.

## Seed Phase

Create `Title` plus `Amount` and populate deterministic row-derived decimal
values in 1,000-row batches.

## Execute Phase

Delete `Amount` as setup, then measure V1 direct restore or the V2 restore stream.

## Primary Metric

- `restoreFieldMs` (initial guardrail: 120,000 ms).

## Verification

Assert both route decisions, restored field identity, and numeric equality over
a complete paged scan.

## Notes

This adds the physical numeric-storage boundary to the restore matrix.
