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

# lookup/customer-update-user-control-field-create-order-4k-depth5

## Goal

Measure whether any preceding User write delays a linked Order create when the
changed field is completely outside the lookup and formula dependency graph.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Users have 10 profile fields and a `sync_marker` control field that
is not referenced by any lookup or formula. Orders have 10 lookups over only
the profile fields followed by a five-level formula chain. Purchases roll up
the final Order formula and derive one more formula.

## Execute Phase

1. PATCH User 20 with a one-field payload that changes only `sync_marker`.
2. Immediately POST Order 4001 linked to User 20 and Purchase 200. No fixed
   sleep is inserted.
3. Poll Order 4001 through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User PATCH start until Order 4001 is fully correct
  through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- The User PATCH contains exactly one field, `sync_marker`, and both write
  routing headers match the requested engine.
- The 10 lookup source fields on User 20 remain unchanged.
- Order 4001 links to User 20 and Purchase 200 with fully correct computed
  values.
- Only Order 4001 and Purchase 200 change in the computed graph; all existing
  Orders remain unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only.

## Notes

Run V1 and V2 production-hybrid only. Local reusable fixtures restore User 20
and delete Order 4001; isolated CI execute databases are discarded.
