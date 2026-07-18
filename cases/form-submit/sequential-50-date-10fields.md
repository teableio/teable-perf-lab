---
owner: perf-lab
tags: [form-submit, form, date, sequential]
enabled: true
---

# form-submit/sequential-50-date-10fields

## Goal

Isolate UTC date parsing and normalization in public form submissions.

## Seed Phase

Skipped. Execute setup creates `Title`, nine UTC date fields, and a Form view.

## Execute Phase

Submit 50 deterministic ISO date payloads with `typecast: true`. Normalize and
check every response/stored date, assert routing, and preserve rows 1/25/50 as
full-scan samples.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

The field formatting is fixed to UTC and date-only display on both engines.
