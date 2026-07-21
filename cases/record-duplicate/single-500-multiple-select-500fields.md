---
owner: perf-lab
tags: [record-duplicate, scale-up, sequential, max-width, v1-v2]
enabled: true
---

# `record-duplicate/single-500-multiple-select-500fields`

## Goal

Maximum-width canary for the record-duplicate matrix: duplicate 500 source records
sequentially when each record has `Title` plus 499 multiple-select fields.

## Seed Phase

Create and validate 1,000 deterministic rows at the supported 500-field table limit.

## Execute Phase

Duplicate the first 500 source rows through the public single-record endpoint, assert
every response and route, then verify all copied values and the final 1,500-row count.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency across the 500 requests, maximum 5,000 ms.
