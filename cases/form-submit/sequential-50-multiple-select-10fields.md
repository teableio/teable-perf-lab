---
owner: perf-lab
tags: [form-submit, form, multiple-select, sequential]
enabled: true
---

# form-submit/sequential-50-multiple-select-10fields

## Goal

Isolate multiple-select array typecasting in public form submissions.

## Seed Phase

Skipped. Execute setup creates nine multi-select fields with four fixed choices
plus the primary field and Form view.

## Execute Phase

Submit 50 deterministic two-choice arrays. Normalize and compare every response
and stored array, assert first/last routing, and retain rows 1/25/50 after the
full scan.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

Ordered array verification prevents a successful but incorrectly typed write
from passing.
