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

# lookup/customer-update-user-first-name-only-create-order-4k-depth5

## Goal

Measure whether changing one User field inside the lookup dependency graph is
enough to delay an immediately created linked Order, without resubmitting the
User title or the other nine unchanged profile fields.

## Seed Phase

Create an isolated deterministic fixture with 40 Users, 4,000 Orders, and 400
Purchases. Each User owns 100 consecutive Orders; each Purchase groups 10
consecutive Orders. Users have 10 profile fields. Orders have 10 lookups over
those fields followed by a five-level formula chain. Purchases roll up the final
Order formula and derive one more formula.

## Execute Phase

1. PATCH User 20 with a one-field payload containing only the changed
   `first_name` value.
2. As soon as that response returns, POST Order 4001 linked to User 20 and
   Purchase 200. No fixed sleep is inserted.
3. Poll Order 4001 through `getRecords` every 100 ms until all lookups and all
   five formulas are correct.
4. Outside the primary timer, verify every User, Order, and Purchase record.

## Primary Metric

- `customerFlowReadyTotalMs`: User PATCH start until Order 4001 is fully correct
  through `getRecords`; maximum 30 seconds.
- `postOrderResponseReadyMs`: Order POST response until that read succeeds;
  maximum 10 seconds.

## Verification

- The User PATCH contains exactly one field, `first_name`, and both write
  routing headers match the requested engine.
- Order 4001 links to User 20 and Purchase 200 and reads the updated first name.
- The updated User value reaches its 100 existing Orders plus Order 4001 and
  Purchases 191-200; 3,900 Orders remain unchanged.
- Full-table verification runs with a 120-second timeout.
- The Computed Outbox is sampled every 50 ms for diagnostics only; its counts do
  not gate pass/fail.

## Notes

This is the narrow-payload sibling of
`lookup/customer-update-user-create-order-4k-depth5`. Treat it as a realistic
payload-shape control, not as a single-sample causal test: production-hybrid
scheduling can make either payload shape hit or miss the same computed-update
lock race. Compare matched repeated runs and inspect the failed advisory-lock
target before attributing a latency difference to payload width. A failed lock
on User 20 identifies overlap on the shared User/lookup edge; payload width is
only a supported cause if it changes the slow-run rate under matched repeated
conditions. Run V1 and V2 production-hybrid only. Local reusable fixtures
restore User 20 and delete Order 4001; isolated CI execute databases are
discarded.
