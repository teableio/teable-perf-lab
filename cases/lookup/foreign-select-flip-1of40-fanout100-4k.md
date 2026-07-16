---
owner: backend-v2
tags:
  - lookup
  - single-select
  - computed
  - fanout
  - read-after-write
  - 4k
  - v1-v2
enabled: true
---

# lookup/foreign-select-flip-1of40-fanout100-4k

## Goal

Measure the customer-visible propagation gap when one cell on a linked foreign
record changes while every order link record id stays unchanged. One User
Status update fans out through lookups, five formula levels, purchase rollups,
and purchase formulas.

## Seed Phase

Use the shared deterministic computed-chain fixture:

- 40 `Users`, all initially `Pending`.
- 4,000 `Orders`; User 20 owns the consecutive window 1,901–2,000.
- 400 `Purchases`; each groups 10 consecutive orders.
- Orders contain four lookups and five dependent formula levels; purchases
  roll up the final order value and derive one more formula.

User 20 therefore affects exactly 100 orders and 10 purchases. The other 3,900
orders are negative controls. Each case gets an isolated cached instance of the
same fixture definition to prevent cross-case mutation leakage.

## Execute Phase

1. Confirm representative seed rows are fully ready.
2. PATCH only User 20's Status field from `Pending` to `Paid`.
3. Poll the first affected order through `getRecord` until its lookup and all
   five formulas expose `Paid`; stop the primary timer.
4. Poll a paged full scan until all 100 affected orders and 10 affected
   purchases converge, while all 3,900 other orders and 390 other purchases
   remain at their seed values.
5. Restore the one User cell on a reusable local fixture and verify seed
   readiness; isolated CI execute databases are discarded.

## Primary Metric

- `firstOrderReadyTotalMs`: User PATCH start until the first affected order is
  readable with the complete new chain.

Diagnostics include `sourceWriteMs`, `postResponsePropagationMs`,
`allAffectedOrdersReadyMs`, and `purchaseCascadeReadyMs`. A second hard
threshold fails if response-after propagation exceeds 10 seconds. The initial
primary guardrail is 15 seconds.

## Verification

- Exactly one User record and one field are written; links are untouched.
- The first affected order proves the direct read-after-write path.
- A full order scan proves exactly 100 changed rows and 3,900 unchanged rows.
- A full purchase scan proves exactly 10 changed cascades and 390 unchanged
  controls.
- First name and email stay unchanged controls on the updated User path.
- PATCH routing headers must match the requested V1/V2 engine.
