---
owner: perf-lab
tags: [record-read, scale-up, filter, range, numeric, 100k, v1-v2]
enabled: true
---

# record-read/100k-50fields-filter-number-range-middle-half

## Goal

Scale the 50k middle-range numeric filter to a shared 100k-row, 50-field fixture.

## Seed Phase

Create or restore the deterministic 100k source and host tables shared by the
Batch 10 numeric-query siblings, then verify all computed fields are ready.

## Execute Phase

Read `A > 25,000 AND A <= 75,000` through 50 pages of 1,000 rows and verify all
50,000 returned records, sampled values, predicate membership, and V1/V2 routing.

## Primary Metric

- `getRecordsQueryPagedScanMs`: actual filtered paged-scan duration, maximum
  120,000 ms. Signed baseline overhead remains secondary artifact evidence.
