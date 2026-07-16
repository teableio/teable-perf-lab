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

# lookup/customer-create-user-create-order-4k-depth5

## Goal

Reproduce the new-customer branch: create a User and immediately create an
Order that links to the returned record id. This covers a dependency target
that did not exist when the fixture's computed graph became ready.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Users expose 10 profile fields. Orders look up all 10, derive a
five-level formula chain, and feed a Purchase rollup plus formula.

## Execute Phase

1. POST User 41 with one complete 10-field payload.
2. Immediately POST Order 4001 linked to the returned User record id and to
   existing Purchase 200. No fixed sleep is inserted.
3. Poll Order 4001 through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User POST start until the target Order is fully
  correct through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- Both POST requests contain exactly one record and their routing headers match
  the requested engine.
- The created User is the sole link target of the created Order; Purchase 200
  gains that Order as its eleventh child.
- Exactly one Order and one Purchase change; all 4,000 seed Orders remain
  unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only.

## Notes

Run V1 and V2 production-hybrid only. Local reusable fixtures delete Order 4001
and User 41; isolated CI execute databases are discarded.
