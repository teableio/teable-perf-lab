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

# lookup/customer-update-user-create-order-4k-depth5

## Goal

Reproduce the customer import order: update an existing User, immediately
create a linked Order, then read that Order. This tests whether the second write
can observe and propagate the first write through a long computed dependency
chain without an artificial delay.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Each User owns 100 consecutive Orders; each Purchase groups 10
consecutive Orders. Users have 10 profile fields. Orders have 10 lookups over
those fields followed by a five-level formula chain. Purchases roll up the final
Order formula and derive one more formula.

## Execute Phase

1. PATCH User 20 with its complete 10-field payload, changing only
   `first_name`.
2. As soon as that response returns, POST Order 4001 linked to User 20 and
   Purchase 200. No fixed sleep is inserted.
3. Poll that Order through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User PATCH start until the target Order is fully
  correct through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- The User and Order requests each contain exactly one record and their routing
  headers match the requested engine.
- The created Order reuses the unchanged User link and joins Purchase 200 as its
  eleventh child.
- The new User value reaches 101 Orders and 10 Purchases; 3,900 Orders remain
  unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only; its counts do
  not gate pass/fail.

## Notes

Run V1 and V2 production-hybrid only. Local reusable fixtures restore User 20
and delete Order 4001; isolated CI execute databases are discarded.
