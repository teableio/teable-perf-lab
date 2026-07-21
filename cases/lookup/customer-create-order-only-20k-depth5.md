---
owner: perf-lab
tags: [lookup, computed, customer-flow, scale-up]
enabled: true
---

# lookup/customer-create-order-only-20k-depth5

## Goal

Scale the order graph from 4,000 to 20,000 rows and per-user fanout from 100 to 500.

## Seed Phase

Build the deterministic 40-user, 20,000-order depth-5 dependency graph.

## Execute Phase

Create one linked Order without a preceding User write and verify the complete computed state.

## Primary Metric

- `customerFlowReadyTotalMs`: measured write-to-ready flow, initial maximum 60,000 ms.
