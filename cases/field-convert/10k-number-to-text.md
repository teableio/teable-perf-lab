---
owner: backend-v2
tags: [field-convert, number, text, 10k, v1-v2]
enabled: true
---

# field-convert/10k-number-to-text

## Goal

Guard number-to-text conversion and formatted value rewrite at 10k rows.

## Seed Phase

Create `Title` plus zero-decimal `Amount`; row `n` stores `n * 7`.

## Execute Phase

Convert `Amount` to single-line text and wait for complete read readiness.

## Primary Metric

- `convertNumberToTextReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert `convertField` routing and the resulting field type, then require every
row to contain the exact decimal string for its generated number.

## Notes

Integer inputs and zero-decimal formatting keep output locale-independent.
