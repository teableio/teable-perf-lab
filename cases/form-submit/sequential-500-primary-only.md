---
owner: perf-lab
tags: [form-submit, scale-up, sequential, v1-v2]
enabled: true
---

# `form-submit/sequential-500-primary-only`

## Goal

Scale-up of `sequential-50-primary-only`: submits 500 deterministic primary-only
records through a Form view. `formSubmitP95Ms` keeps the per-request latency
contract; the loop phase records aggregate work. V1/V2 routing and all 500
stored rows are verified.

## Seed Phase

Skipped. Execute setup creates the deterministic table and Form view.

## Execute Phase

Submit every generated row sequentially through the public Form endpoint, assert first/last V1/V2 routing, and verify the complete stored result.

## Primary Metric

- `formSubmitP95Ms`: p95 latency across the sequential requests, maximum 2,000 ms.
