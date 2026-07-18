---
owner: perf-lab
tags: [form-submit, form, long-text, sequential]
enabled: true
---

# form-submit/sequential-50-long-text-10fields

## Goal

Isolate long-text typecasting and storage in the public Form endpoint.

## Seed Phase

Skipped. Execute setup creates `Title`, nine long-text fields, and a Form view.

## Execute Phase

Submit 50 deterministic long-text payloads sequentially. Verify every response
and every stored cell, assert first/last routing, and record rows 1/25/50 as
artifact samples.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

The ten-field text case is the same-width plain-text control.
