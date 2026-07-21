---
owner: perf-lab
tags: [record-read, query, scale-up, v1-v2]
enabled: true
---

# record-read/50k-50fields-sort-text-ascending

## Goal

Scale the matching 10k query variant to the shared deterministic 50,000-row, 50-field fixture and sort by Text 1 ascending.

## Seed Phase

Reuse or build the runner's shared 50,000-row host/source fixture and verify its boundary samples.

## Execute Phase

Run the same paged baseline scan and query scan as the baseline case. Require 50,000 query-result rows, deterministic ordering/samples, and matched V1/V2 read routing.

## Primary Metric

- `getRecordsQueryOverheadMs`: query scan time minus baseline scan time, clamped at zero; initial maximum 30,000 ms.
