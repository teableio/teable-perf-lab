---
owner: perf-lab
tags: [lookup, computed, fanout, scale-up]
enabled: true
---

# lookup/foreign-select-flip-1of40-fanout500-20k

## Goal

Scale one foreign-select mutation from a 100-order to a 500-order depth-5 fanout.

## Seed Phase

Build the deterministic 40-user, 20,000-order computed dependency graph.

## Execute Phase

Flip one foreign select through the baseline bulk-write path, assert routing, and verify first plus full 500-order readiness.

## Primary Metric

- `firstOrderReadyTotalMs`: mutation-to-first-dependent-order-ready latency, initial maximum 60,000 ms.
