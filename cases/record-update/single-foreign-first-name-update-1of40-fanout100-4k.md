---
owner: backend-v2
tags:
  - record-update
  - update-record
  - lookup
  - computed
  - fanout
  - 4k
  - v1-v2
enabled: true
---

# record-update/single-foreign-first-name-update-1of40-fanout100-4k

## Goal

Measure the distinct single-record `updateRecord` route for one normal text-cell
edit and its propagation through 100 Orders, five formula levels, and 10
Purchase aggregates.

## Seed Phase

Reuse the deterministic 40-User, 4,000-Order, 400-Purchase graph from the bulk
foreign-first-name case. User 20 owns the affected 100 Orders and 10 Purchases.

## Execute Phase

PATCH only User 20's `first_name` through
`/api/table/{tableId}/record/{recordId}`. Poll the first affected Order until its
lookup and all five formulas expose the new value, then verify the complete
affected and control graph outside the primary stop point.

## Primary Metric

- `firstOrderReadyTotalMs`: single-record PATCH start until the first affected
  Order is readable with the complete new chain.

The 15-second guardrail intentionally matches the bulk-route sibling so the
endpoint is the only workload delta.

## Verification

- Routing must match feature `updateRecord`, not `updateRecords`.
- Exactly one User field is changed.
- All 100 affected Orders and 10 Purchases must converge.
- All 3,900 control Orders and 390 control Purchases must remain unchanged.

## Notes

This case shares the data topology and expected-value model with the existing
bulk endpoint case; it exists because the product canary routes are separate.
