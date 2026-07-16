---
owner: backend-v2
tags:
  - lookup
  - text
  - computed
  - fanout
  - read-after-write
  - 4k
  - v1-v2
enabled: true
---

# lookup/foreign-first-name-update-1of40-fanout100-4k

## Goal

Measure the same unchanged-link propagation path for a normal one-cell text
edit. This matches the user operation: edit one field once, rather than sending
a synthetic multi-field update.

## Seed Phase

Use the same deterministic 40-User, 4,000-Order, 400-Purchase fixture as the
single-select case. User 20 owns orders 1,901–2,000 and purchases 191–200.
Orders carry first-name, last-name, email, and Status lookups followed by five
formula levels; purchases roll up the final order formula and derive one more
formula.

Each case gets an isolated cached instance of the identical fixture definition
so it remains independently runnable and cannot inherit another case's record
or schema mutation.

## Execute Phase

1. Confirm representative seed rows are fully ready.
2. PATCH only User 20's first-name field from `First-020` to
   `First-020-updated`.
3. Poll the first affected order through `getRecord` until the lookup and all
   five formulas expose the new text; stop the primary timer.
4. Poll full order and purchase scans until the complete affected fanout is
   ready and every unaffected row still matches its seed value.
5. Restore the one User cell on a reusable local fixture and verify seed
   readiness; isolated CI execute databases are discarded.

## Primary Metric

- `firstOrderReadyTotalMs`: User PATCH start until the first affected order is
  readable with the complete new chain.

Diagnostics include `sourceWriteMs`, `postResponsePropagationMs`,
`allAffectedOrdersReadyMs`, and `purchaseCascadeReadyMs`. Response-after
propagation has a 10-second hard threshold; the initial primary guardrail is 15
seconds.

## Verification

- Exactly one User record and only `first_name` are written.
- All 100 affected orders and 10 affected purchases expose the new value.
- All 3,900 other orders and 390 other purchases remain unchanged.
- Email and Status remain unchanged controls on the updated User path.
- User/order links keep the same record ids throughout.
- PATCH routing headers must match the requested V1/V2 engine.
