---
owner: perf-lab
tags: [record-read, scale-up, filter, sort, numeric, 100k, v1-v2]
enabled: true
---

# record-read/100k-50fields-filter-number-sort-descending

## Goal

Scale the 50k upper-half numeric filter and descending sort to a shared
100k-row, 50-field fixture.

## Seed Phase

Create or restore the deterministic 100k source and host tables shared by the
Batch 10 numeric-query siblings, then verify all computed fields are ready.

## Execute Phase

Read `A > 50,000` ordered by `A` descending through 50 pages of 1,000 rows and
verify all 50,000 returned records, sorted order, sampled values, and V1/V2 routing.

## Primary Metric

- `getRecordsQueryPagedScanMs`: actual filtered-and-sorted paged-scan duration,
  maximum 120,000 ms. Signed baseline overhead remains secondary artifact evidence.
