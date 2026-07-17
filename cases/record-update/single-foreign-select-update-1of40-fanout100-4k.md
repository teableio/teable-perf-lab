---
owner: backend-v2
tags:
  - record-update
  - update-record
  - single-select
  - lookup
  - computed
  - fanout
  - 4k
  - v1-v2
enabled: true
---

# record-update/single-foreign-select-update-1of40-fanout100-4k

## Goal

Measure the single-record `updateRecord` route for one option-backed Status edit
and its propagation through the same 100-Order depth-five computed fanout.

## Seed Phase

Reuse the deterministic 40-User, 4,000-Order, 400-Purchase graph. User 20 owns
the affected 100 Orders and 10 Purchases; all other records are controls.

## Execute Phase

PATCH only User 20's Status through
`/api/table/{tableId}/record/{recordId}`. Stop the primary timer when the first
affected Order exposes the new lookup and complete formula chain, then verify
the full graph.

## Primary Metric

- `firstOrderReadyTotalMs`: single-record PATCH start until the first affected
  Order is fully readable.

The initial 15-second threshold matches the bulk-route sibling.

## Verification

- Routing must match feature `updateRecord`.
- Exactly one User Status cell is changed.
- All 100 affected Orders and 10 Purchases must converge.
- All unaffected Orders/Purchases and non-Status User fields remain controls.

## Notes

Select option resolution and serialization differ from plain text, so this case
keeps a separate history group while reusing the same graph and write mode.
