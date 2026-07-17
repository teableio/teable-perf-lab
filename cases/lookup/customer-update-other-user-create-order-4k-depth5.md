---
owner: backend-v2
tags:
  - lookup
  - computed
  - customer-upsert
  - causal-isolation
  - read-after-write
  - 4k
  - v1-v2
enabled: true
---

# lookup/customer-update-other-user-create-order-4k-depth5

## Goal

Measure whether a User update delays an immediately created Order whose User
and Purchase links belong to a different dependency subgraph.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Each User owns 100 consecutive Orders; each Purchase groups 10
consecutive Orders. Users have 10 profile fields. Orders have 10 lookups and a
five-level formula chain. Purchases roll up the final Order formula and derive
one more formula.

## Execute Phase

1. PATCH User 20 with its complete payload, changing only `first_name`.
2. Immediately POST Order 4001 linked to User 21 and Purchase 210. This keeps
   the second write outside User 20's Orders and Purchases. No fixed sleep is
   inserted.
3. Poll Order 4001 through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify User 20's full cascade plus every User,
   Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User 20 PATCH start until Order 4001 is fully
  correct through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- The User PATCH logically changes only `first_name`; both write routing
  headers match the requested engine.
- Order 4001 links only to User 21 and Purchase 210 and reads User 21's unchanged
  profile values.
- User 20's update affects its 100 existing Orders and Purchases 191-200, while
  the new Order affects Purchase 210; the two write targets share neither User
  nor Purchase dependencies.
- The final impact is 101 changed Orders and 11 changed Purchases, with 3,900
  existing Orders unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only.

## Notes

Run V1 and V2 production-hybrid only. Local reusable fixtures restore User 20
and delete Order 4001; isolated CI execute databases are discarded.
