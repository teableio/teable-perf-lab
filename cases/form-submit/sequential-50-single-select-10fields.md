---
owner: perf-lab
tags: [form-submit, form, single-select, sequential]
enabled: true
---

# form-submit/sequential-50-single-select-10fields

## Goal

Isolate single-select choice resolution in public form submissions.

## Seed Phase

Skipped. Execute setup creates nine select fields with three fixed choices plus
the primary field and Form view.

## Execute Phase

Submit 50 rows cycling exact choice names with `typecast: true`. Check every
response and stored choice, assert first/last routing, and retain rows 1/25/50
after the full scan.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

Choice creation is setup; the metric covers only form-submit requests.
