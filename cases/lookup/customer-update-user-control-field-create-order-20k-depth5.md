---
owner: perf-lab
tags: [lookup, computed, customer-flow, scale-up]
enabled: true
---

# lookup/customer-update-user-control-field-create-order-20k-depth5

## Goal

Scale the order graph from 4,000 to 20,000 rows and per-user fanout from 100 to 500.

## Seed Phase

Build the deterministic 40-user, 20,000-order depth-5 dependency graph.

## Execute Phase

Update one non-computed User field, create one linked Order, and verify readiness and unchanged computed values.

## Primary Metric

- `customerFlowReadyTotalMs`: measured write-to-ready flow, initial maximum 60,000 ms.
