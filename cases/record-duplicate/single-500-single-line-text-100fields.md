---
owner: perf-lab
tags: [record-duplicate, scale-up, sequential, wide-table, v1-v2]
enabled: true
---

# `record-duplicate/single-500-single-line-text-100fields`

## Goal

Scale-up of `single-500-single-line-text-10fields`: duplicate 500 source records
sequentially while increasing each record from 10 to 100 single-line text fields.

## Seed Phase

Create and validate 1,000 deterministic rows in a 100-field text table before timing.

## Execute Phase

Duplicate the first 500 source rows through the public single-record endpoint, assert
every response and route, then verify all copied values and the final row count.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency across the 500 requests, maximum 5,000 ms.
