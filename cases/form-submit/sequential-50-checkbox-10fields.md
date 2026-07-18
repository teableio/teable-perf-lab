---
owner: perf-lab
tags: [form-submit, form, checkbox, sequential]
enabled: true
---

# form-submit/sequential-50-checkbox-10fields

## Goal

Isolate checked/empty checkbox typecasting in public form submissions.

## Seed Phase

Skipped. Execute setup creates `Title`, nine checkbox fields, and a Form view.

## Execute Phase

Submit 50 rows alternating `true` and empty checkbox values. Check every
response and stored cell, assert first/last routing, then preserve rows 1/25/50
from the complete scan.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

The case verifies null/empty semantics, not only successful record creation.
