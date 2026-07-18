---
owner: perf-lab
tags: [form-submit, form, primary-field, sequential]
enabled: true
---

# form-submit/sequential-50-primary-only

## Goal

Establish the narrowest public form-submit baseline with 50 sequential
primary-only submissions.

## Seed Phase

Skipped. Execute setup creates an empty one-field table and Form view.

## Execute Phase

Submit 50 deterministic titles through the public Form endpoint with
`typecast: true`. Check every response, assert first/last routing, then full-scan
all rows and retain rows 1/25/50 as value evidence.

## Primary Metric

- `formSubmitP95Ms`: p95 request latency, maximum 2,000 ms.

## Notes

Table/Form creation, final verification, and cleanup are outside the metric.
