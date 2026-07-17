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

# lookup/customer-create-order-only-4k-depth5

## Goal

Measure whether creating a fully linked Order has an inherent propagation delay
when no User write precedes it.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Users have 10 profile fields. Orders have 10 lookups over those
fields followed by a five-level formula chain. Purchases roll up the final
Order formula and derive one more formula.

## Execute Phase

1. Do not write any User record.
2. POST Order 4001 linked to existing User 20 and Purchase 200.
3. Poll Order 4001 through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: Order POST start until Order 4001 is fully correct
  through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- The Order POST contains exactly one complete writable record and its routing
  header matches the requested engine.
- User 20 remains unchanged and is the sole User link target of Order 4001.
- Purchase 200 gains Order 4001 as its eleventh child.
- Exactly one Order and one Purchase change; all 4,000 seed Orders remain
  unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only.

## Notes

Run V1 and V2 production-hybrid only. No fixed sleep is inserted. Local
reusable fixtures delete Order 4001; isolated CI execute databases are
discarded.
