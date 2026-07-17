---
owner: backend-v2
tags: [field-restore, multiple-select, trash, 10k, v1-v2]
enabled: true
---

# field-restore/10k-tags-field

## Goal

Measure restoring 10,000 populated multiple-select cells from field trash.

## Seed Phase

Create `Title` plus `Tags`. Every row receives a deterministic ordered pair from
`Alpha`, `Beta`, `Gamma`, and `Delta`.

## Execute Phase

Delete `Tags`, resolve the matching trash item, and measure the engine-specific
restore path until completion.

## Primary Metric

- `restoreFieldMs` (initial guardrail: 120,000 ms).

## Verification

Assert delete/restore routing, restored field identity, row count, and exact
ordered arrays for all 10,000 rows.

## Notes

Array-backed option values exercise a different restore representation from the
existing single-select case.
