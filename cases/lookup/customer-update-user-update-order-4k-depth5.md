---
owner: backend-v2
tags:
  - lookup
  - computed
  - customer-upsert
  - read-after-write
  - 4k
  - v1-v2
enabled: true
---

# lookup/customer-update-user-update-order-4k-depth5

## Goal

Reproduce a customer upsert where an existing User is updated and an existing
linked Order is immediately updated. The link record id does not change, so the
case exercises propagation from both a foreign-table value change and a host
record value change rather than link creation.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Each User owns 100 consecutive Orders; each Purchase groups 10
consecutive Orders. Users expose 10 profile fields. Orders look up all 10,
derive a five-level formula chain, and feed a Purchase rollup plus formula.

## Execute Phase

1. PATCH User 20 with its complete 10-field payload, changing only
   `first_name`.
2. Immediately PATCH deterministic Order 2000 with its complete writable
   payload, changing only `status` and resending the same User and Purchase
   record ids.
3. Poll Order 2000 through `getRecords` every 100 ms until the new status, all
   lookups, and all five formulas are mutually consistent.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User PATCH start until Order 2000 is fully correct
  through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order PATCH response until that read succeeds;
  maximum 10 seconds.

## Verification

- Both PATCH requests contain exactly one record and their routing headers match
  the requested engine.
- User and Purchase link record ids remain unchanged.
- The User update reaches exactly 100 Orders and 10 Purchases; the status update
  affects only Order 2000 inside that fanout; 3,900 Orders remain unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only.

## Notes

Run V1 and V2 production-hybrid only. Local reusable fixtures restore Order
2000 and User 20; isolated CI execute databases are discarded.
