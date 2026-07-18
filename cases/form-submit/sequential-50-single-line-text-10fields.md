---
owner: perf-lab
tags: [form-submit, form, text, sequential]
enabled: true
---

# form-submit/sequential-50-single-line-text-10fields

## Goal

Isolate plain-text form submission at a fixed ten-field width.

## Seed Phase

Skipped. Execute setup creates `Title`, nine text fields, and a Form view.

## Execute Phase

Submit 50 deterministic 10-field payloads sequentially with `typecast: true`.
Check all 500 response cells, assert routing, then full-scan all stored values
and preserve rows 1/25/50 as samples.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

Compare with primary-only and 20-field text variants for width scaling.
