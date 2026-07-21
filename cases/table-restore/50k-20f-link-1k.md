---
owner: perf-lab
tags: [table-restore, link, scale-up, v1-v2]
enabled: true
---

# table-restore/50k-20f-link-1k

## Goal

Scale the restored link-owning host table from 10,000 to 50,000 rows while keeping the foreign table at 1,000 rows.

## Seed Phase

Build and validate the deterministic host/foreign tables and 50,000 populated link cells.

## Execute Phase

Archive and restore the host table for five samples, assert routing, and verify records, field structure, and links.

## Primary Metric

- `restoreTableP95Ms`: p95 restore-request latency, maximum 2,000 ms.
