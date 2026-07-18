---
owner: perf-lab
tags: [form-submit, form, text, width-scaling, sequential]
enabled: true
---

# form-submit/sequential-50-single-line-text-20fields

## Goal

Expose form payload-width cost with 50 sequential 20-field text submissions.

## Seed Phase

Skipped. Execute setup creates `Title`, nineteen text fields, and a Form view.

## Execute Phase

Submit 1,000 deterministic text cells across 50 requests. Check every response
and stored value, assert first/last routing, and retain rows 1/25/50 after the
complete scan.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

Compare with the ten-field text case for width scaling and the existing
mixed-field 200-submit case for type-mix behavior.
