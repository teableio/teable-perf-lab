---
owner: perf-lab
tags: [field-create, single-select, scale-up, v1-v2]
enabled: true
---

# field-create/10x-single-select-1k-options

## Goal

Scale one 1,000-option single-select creation to ten sequential fields at the same per-field product limit.

## Seed Phase

Create or reuse one empty primary-only table.

## Execute Phase

Create ten fields sequentially, assert every V1/V2 route, and verify 1,000 options and sampled choices on every field.

## Primary Metric

- `createScalarFieldsMs`: total latency for ten field-create requests, initial maximum 20,000 ms.
