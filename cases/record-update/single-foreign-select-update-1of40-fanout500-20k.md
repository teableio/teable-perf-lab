---
owner: perf-lab
tags: [record-update, computed, fanout, scale-up]
enabled: true
---

# record-update/single-foreign-select-update-1of40-fanout500-20k

## Goal

Scale the single-record foreign-select update from a 100-order to a 500-order depth-5 fanout.

## Seed Phase

Build the deterministic 40-user, 20,000-order computed dependency graph.

## Execute Phase

Update one select through the single-record endpoint, assert routing, and verify first plus full 500-order readiness.

## Primary Metric

- `firstOrderReadyTotalMs`: mutation-to-first-dependent-order-ready latency, initial maximum 60,000 ms.
