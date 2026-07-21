---
owner: backend-v2
tags: [form-submit, 500, 100-fields, date, scale-up, v1-v2]
enabled: true
---

# form-submit/sequential-500-date-100fields

## Goal

Measure single-record Form submission p95 when each request writes 100 date fields.

## Seed Phase

No records are seeded. Setup creates an empty Form table with `Title` plus 99 UTC date fields.

## Execute Phase

Submit 500 deterministic records sequentially, assert routing, then full scan all rows, normalize dates, and verify rows 1, 250, and 500.

## Primary Metric

- `formSubmitP95Ms`, initial guardrail `maxMs: 5_000`.

## Notes

This scales per-request width from the ten-field sibling while keeping sample count and metric semantics fixed. Setup, verification, and cleanup are outside the p95.
