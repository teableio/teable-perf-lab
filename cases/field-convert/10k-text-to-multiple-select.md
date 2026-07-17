---
owner: backend-v2
tags: [field-convert, text, multiple-select, json, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-multiple-select

## Goal

Guard comma-list parsing and TEXT-to-JSON rewriting across 10,000 rows.

## Seed Phase

Create `Title` plus `Multi Text`; rows cycle deterministic pairs from `Alpha`,
`Beta`, `Gamma`, and `Delta`.

## Execute Phase

Convert to multiple select with `Alpha` and `Beta` predefined.

## Primary Metric

- `convertTextToMultipleSelectReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert route, target type, the exact four-choice metadata set, and every ordered
two-value array in a complete scan.

## Notes

Quoted-delimiter edge cases remain correctness-test territory; this case keeps a
stable performance workload.
