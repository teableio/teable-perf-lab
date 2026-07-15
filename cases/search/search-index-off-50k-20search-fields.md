---
owner: backend-v2
tags:
  - lookup
  - search-index
  - table-index-off
  - 50k
  - v1-v2
enabled: true
---

# search/search-index-off-50k-20search-fields

## Goal

Measure global `aggregation/search-index` latency on the 50k-row host table
whose `TableIndex.search` is disabled.

The seed fixture is shared with the ON case and contains source, OFF host, and
ON host tables so both cases can use the same deterministic DB seed cache.

## Seed Phase

See `docs/lookup-search-index-table-spec.md` for the full table layout. The
measured OFF host has 20 searchable fields:

- native host key/text/number/date/select/multiple-select/user fields.
- lookup-derived text/number/date/select/multiple-select/user fields.

Date fields are part of the 20-field layout, but they are intentionally not used
as search keywords because global search does not match date values.

## Execute Phase

For each keyword, call only the OFF host table:

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

- `lookupSearchIndexP95Ms`: p95 latency across all OFF host samples.

The sample set contains only requests against the OFF host table. Each sample
measures one `aggregation/search-index` request and includes response
verification for hit count and first-hit field group. The primary p95 does not
include fixture creation, user seeding, lookup-field creation, ON-host index
activation, or `seedReady`; those are reported as diagnostic metrics such as
`createTablesMs`, `seedUsersMs`, `seedSourceMs`, `seedOffHostMs`,
`seedOnHostMs`, `createLookupFieldsMs`, `activateSearchIndexOnHostMs`, and
`seedReadyMs`.

Trace capture saves representative raw Jaeger snapshots for samples 1, 15, and
30 of each keyword; all 30 samples still participate in the p95 metric and are
kept in the result JSON.

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

The initial `maxMs` is 5,000 ms. The 50k row count and guardrail are inferred scale defaults and should be recalibrated from CI history.
