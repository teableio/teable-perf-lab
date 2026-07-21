---
owner: perf-lab
tags: [record-delete, link, scale-up, v1-v2]
enabled: true
---

# record-delete/link-trash-5k

## Goal

Scale linked selection delete from 1,000 to 5,000 referenced records.

## Seed Phase

Build deterministic 5,000-row host and foreign tables with populated link cells.

## Execute Phase

Delete the full host selection, assert V1/V2 routing, and verify all records are trashed and foreign links are detached.

## Primary Metric

- `deleteLinked5kMs`: linked selection-delete latency, initial maximum 10,000 ms.
