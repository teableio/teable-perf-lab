---
owner: backend-v2
tags: [field-convert, text, checkbox, coercion, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-checkbox-mixed

## Goal

Guard text truthiness conversion across populated and null rows.

## Seed Phase

Create `Title` plus `Truthy Text`; odd rows contain a non-empty token and even
rows are null.

## Execute Phase

Convert `Truthy Text` to checkbox and wait for full readiness.

## Primary Metric

- `convertTextToCheckboxReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert route and target type. Non-empty rows must become true; null rows must
remain unchecked/null throughout the 10,000-row scan.

## Notes

The case intentionally does not assign special semantics to the string `false`.
