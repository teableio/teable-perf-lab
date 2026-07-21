---
owner: perf-lab
tags: [duplicate-view, wide-table, scale-up, v1-v2]
enabled: true
---

# duplicate-view/complex-grid-500fields-p95

## Goal

Scale the complex grid from 20 to the 500-field product boundary.

## Seed Phase

No record seed is required; execute setup creates the deterministic 500-field table and configured source grid.

## Execute Phase

Duplicate the configured grid 30 times, assert V1/V2 routing, and verify every duplicated view definition.

## Primary Metric

- `duplicateViewP95Ms`: p95 duplicate-view request latency, maximum 2,000 ms.
