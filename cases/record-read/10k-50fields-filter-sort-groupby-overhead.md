---
owner: backend-v2
tags:
  - record-read
  - get-records
  - filter
  - sort
  - group-by
  - 10k
  - 50fields
  - v1-v2
enabled: true
---

# record-read/10k-50fields-filter-sort-groupby-overhead

## Goal

Measure the extra cost of adding explicit filter, sort, and groupBy query
semantics to the same 10,000-row, 50-projected-field read workload used by
`record-read/10k-50fields-10x1k-pages`.

## Seed Phase

Reuse the same record-read source and host fixture shape:

- 10,000 source rows with 20 deterministic lookup payload fields.
- 10,000 host rows with `Title`, `Lookup Source Key`, numeric fields `A/B/C`,
  and 20 text fields.
- 5 formula fields.
- 20 conditional lookup fields.
- A 50-field projection that is full-scan verified before execute.

With seed caching enabled, the runner reuses the same hash-derived source/host
tables as the no-query read case when the seed config matches.

## Execute Phase

1. Restore or build the ready 10k/50-field fixture.
2. Run the baseline measurement: ten sequential 1,000-record `GET /record`
   pages with the same projection and no explicit filter, sort, or groupBy.
3. Run the query-variant measurement: ten sequential 1,000-record pages with:
   - filter: `Text 1 is not empty`;
   - orderBy: `A asc`;
   - groupBy: `Text 2 asc`.
4. Verify both measurements return readable projected records with deterministic
   field values and expected V1/V2 routing headers.

## Primary Metric

- `getRecordsFilterSortGroupByOverheadMs`: query-variant paged-scan time minus
  baseline paged-scan time on the same warmed fixture, **clamped at 0**. When the
  query variant runs at or below the baseline the overhead is reported as 0 so a
  negative delta cannot trivially satisfy the threshold; the raw signed delta is
  preserved as `getRecordsFilterSortGroupByOverheadSignedMs`.

The artifact also reports `getRecordsBaselinePagedScanMs`,
`getRecordsQueryPagedScanMs`, `getRecordsFilterSortGroupByOverheadSignedMs`, and
`getRecordsFilterSortGroupByOverheadRatio`.

## Notes

This case is intentionally paired with
`record-read/10k-50fields-10x1k-pages`. It answers how much the same read shape
slows down after product query semantics are added, rather than measuring a
different table or projection.

The filter (`Text 1 is not empty`) targets an always-populated field, so it is a
match-all filter by design: the goal is to measure the cost of attaching
filter/sort/groupBy semantics to the full result set, not filter selectivity. The
query variant additionally asserts that returned rows are distinct and within
`[1, rowCount]`, so a reshaped paged groupBy scan cannot silently duplicate or
overrun rows.
