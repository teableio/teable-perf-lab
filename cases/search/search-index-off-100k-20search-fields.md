---
owner: perf-lab
tags: [search-index-off, lookup, scale-up, v1-v2]
enabled: true
---

# search/search-index-off-100k-20search-fields

## Goal

Scale the index-off lookup global-search fixture from 50,000 to 100,000 linked host/source rows.

## Seed Phase

Build deterministic 100,000-row source and host tables with the table search index disabled.

## Execute Phase

Run the same 30-sample keyword mix as the 50k baseline, but move the three
formerly unique probes to row 99,999 so substring matching remains unique at
100k (`A1-Value-99999`, `A-Key-99999`, and
`HostText1-Value-99999`). Assert expected hit groups and V1/V2 routing, and
verify boundary rows.

## Primary Metric

- `lookupSearchIndexP95Ms`: p95 search latency, initial maximum 10,000 ms.
