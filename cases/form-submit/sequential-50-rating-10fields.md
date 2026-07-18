---
owner: perf-lab
tags: [form-submit, form, rating, sequential]
enabled: true
---

# form-submit/sequential-50-rating-10fields

## Goal

Isolate five-star rating typecasting in public form submissions.

## Seed Phase

Skipped. Execute setup creates `Title`, nine rating fields, and a Form view.

## Execute Phase

Submit 50 rows cycling ratings 1-5 with `typecast: true`. Check every response
and stored rating, assert first/last routing, and preserve rows 1/25/50 as
full-scan evidence.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

The number case is the same-width unbounded numeric control.
