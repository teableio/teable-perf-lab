---
owner: backend-v2
tags: [field-convert, multiple-select, choices, prune, 10k, v1-v2]
enabled: true
---

# field-convert/10k-multiple-select-choice-prune

## Goal

Guard filtering and rename semantics over 10,000 multiple-select JSON arrays.

## Seed Phase

Create stable-id `Alpha`, `Beta`, `Gamma`, and `Delta` choices with deterministic
two-value arrays.

## Execute Phase

Keep only the `Alpha` id, rename it to `Primary`, and remove all other choices.

## Primary Metric

- `convertMultipleSelectChoicesReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert route and the single `Primary` choice. Arrays containing `Alpha` become
`["Primary"]`; arrays without it become null across the full scan.

## Notes

This is the JSON-array counterpart to scalar single-select pruning.
