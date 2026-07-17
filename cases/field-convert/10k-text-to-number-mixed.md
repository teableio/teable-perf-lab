---
owner: backend-v2
tags: [field-convert, text, number, coercion, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-number-mixed

## Goal

Guard numeric parsing and invalid-value clearing while rewriting 10,000 text
cells to number storage.

## Seed Phase

Create `Title` plus `Numeric Text`. Three of every four rows contain a
deterministic decimal string; the fourth contains an invalid token.

## Execute Phase

Convert `Numeric Text` to number and wait for sample plus full-table readiness.

## Primary Metric

- `convertTextToNumberReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert `convertField` routing and number target type. Valid strings must become
numbers, invalid strings must become null, and every row must be scanned.

## Notes

The mixed fixture exercises both parse and clear paths in one deterministic run.
