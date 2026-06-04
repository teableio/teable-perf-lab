---
owner: backend-v2
tags:
  - lookup
  - search-index
  - table-index-on
  - 10k
  - v1-v2
enabled: true
---

# lookup/search-index-on-10k-20search-fields

## Goal

Measure global `aggregation/search-index` latency on the 10k-row host table
whose `TableIndex.search` is enabled.

The seed fixture is shared with the OFF case and contains source, OFF host, and
ON host tables so both cases can use the same deterministic DB seed cache.

## Seed

See `docs/lookup-search-index-table-spec.md` for the full table layout. The
measured ON host has 20 searchable fields:

- native host key/text/number/user fields.
- lookup-derived key/text/user fields.

The runner turns `TableIndex.search` on for the ON host after lookup values are
ready, and validates that the index remains active when restoring from cache.

## Execute

For each keyword, call only the ON host table:

```text
GET /api/table/{tableId}/aggregation/search-index
  ?skip=0
  &take=100
  &viewId={viewId}
  &search[]={keyword}
  &search[]=
  &search[]=true
```

Default samples: 30 per keyword.

## Primary Metric

- `lookupSearchIndexP95Ms`: p95 latency across all ON host samples.

## Keywords

- `A1-Value-9522`: one-hit lookup-result search, expected field group
  `lookup-text`.
- `A-Key-9999`: five-hit native lookup-key search, expected field group
  `lookup-key`.
- `A-Key-45`: high-hit native lookup-key search with at least 100 field hits
  after `take=100` row selection.
