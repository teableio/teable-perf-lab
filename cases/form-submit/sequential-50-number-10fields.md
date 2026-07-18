---
owner: perf-lab
tags: [form-submit, form, number, sequential]
enabled: true
---

# form-submit/sequential-50-number-10fields

## Goal

Isolate numeric typecasting in 50 sequential public form submissions.

## Seed Phase

Skipped. Execute setup creates `Title`, nine number fields, and a Form view.

## Execute Phase

Submit row-number-derived numeric payloads with `typecast: true`. Check every
response and stored number, assert first/last routing, and retain rows 1/25/50
as samples after the full scan.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

The rating case is the same-width bounded numeric comparison.
