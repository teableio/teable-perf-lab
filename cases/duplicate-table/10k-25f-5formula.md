---
owner: perf-lab
tags:
  - duplicate-table
  - formula
  - records
enabled: true
---

# duplicate-table/10k-25f-5formula

## Goal

Measure duplicating a 10,000-record complex mixed table with 25 stored fields,
5 formula fields, and records included.

## Seed Phase

Create a deterministic source table in the seeded base with 10,000 records,
25 stored mixed fields. The fields cover text, long text, single select,
multiple select, number, date, checkbox, rating, URL text, email text, and
additional reviewer/source/region/department columns.

After record insertion, the runner adds these formula fields:

- `Total Value`: `{Amount} * {Quantity}`
- `Amount Plus Quantity`: `{Amount} + {Quantity}`
- `Percent Score`: `{Percent} * 100`
- `Quantity Plus Percent`: `{Quantity} + {Percent}`
- `Amount Times Percent`: `{Amount} * {Percent}`

The runner validates the source table with a paged full scan before measurement,
including formula values.

## Execute Phase

1. Reuse or create the seed source table.
2. Call `POST /api/base/{baseId}/table/{tableId}/duplicate` with
   `includeRecords: true`.
3. Resolve the duplicated field and view ids from the response maps.
4. Verify that all 5 formula fields were duplicated.
5. Full-scan the duplicated table through `getRecords` and verify all 10,000
   records and all 25 stored fields.
6. Delete the duplicated table during local cleanup. The reusable source table
   remains cacheable.

## Primary Metric

- `duplicateTableRequestMs`: `POST /duplicate` request duration with
  `includeRecords: true`. This includes table structure duplication, record
  value copy, and formula field metadata copy until the API returns.

## Verification Metrics

- `duplicateTableFullScanReadyMs`: post-response full-scan verification time.
  This proves all 10,000 duplicated records and all 25 stored fields are
  readable and correct, but it does not participate in the primary threshold.
- `duplicateTableTotalReadyMs`: request duration plus full-scan verification
  time, kept as an end-to-end reference.

## Notes

- This case includes formula field duplication but does not use duplicated
  formula cell values as the cross-engine pass condition. The duplicate-table
  metric is scoped to table duplication, field mapping, record copy, and stored
  field readiness; formula calculation readiness is covered by formula-specific
  cases.
- This case deliberately keeps relation and lookup fields out of scope so it
  isolates single-table duplication with records and formula metadata. Later
  cases should cover cross-table copy behavior separately.
- Source table creation and seed validation are setup phases and are not part of
  the primary metric.
- The case records duplicate-table routing headers and fails V1/V2 runs on
  engine mismatch, so dispatch can be checked from the artifact.
