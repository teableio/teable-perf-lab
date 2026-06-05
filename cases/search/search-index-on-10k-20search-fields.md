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

# search/search-index-on-10k-20search-fields

## Goal

Measure global `aggregation/search-index` latency on the 10k-row host table
whose `TableIndex.search` is enabled.

The seed fixture is shared with the OFF case and contains source, OFF host, and
ON host tables so both cases can use the same deterministic DB seed cache.

## Seed Phase

See `docs/lookup-search-index-table-spec.md` for the full table layout. The
measured ON host has 20 searchable fields:

- native host key/text/number/date/select/multiple-select/user fields.
- lookup-derived text/number/date/select/multiple-select/user fields.

Date fields are part of the 20-field layout, but they are intentionally not used
as search keywords because global search does not match date values.

The runner turns `TableIndex.search` on for the ON host after lookup values are
ready, and validates that the index remains active when restoring from cache.

## Execute Phase

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

## Notes

Keywords:

- `A1-Value-9522`: one-hit lookup-result search, expected field group
  `lookup-text`.
- `A-Key-9999`: two-hit native lookup-key search, expected field group
  `lookup-key`.
- `HostText1-Value-9522`: one-hit native own-text search, expected field group
  `own-text`.
- `Todo`: capped native single-select search, expected field group
  `own-select`.
- `Alpha`: capped lookup single-select search, expected field group
  `lookup-select`.
- `North`: capped native multiple-select search, expected field group
  `own-multiple-select`.
- `Red`: capped lookup multiple-select search, expected field group
  `lookup-multiple-select`.
- `perf_lookup_user_0`: capped native/lookup user search, expected field group
  `user`.
- `A-Key-45`: high-hit native lookup-key search with at least 100 field hits
  after `take=100` row selection.
