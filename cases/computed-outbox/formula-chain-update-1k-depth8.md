---
owner: backend-v2
tags:
  - computed
  - outbox
  - formula
  - propagation
  - v1-v2
enabled: true
---

# computed-outbox/formula-chain-update-1k-depth8

## Goal

Measure the real write-to-readable window when V2 hybrid queues a 1,000-record
`seed` task and the Worker plans and executes an eight-level same-table formula
chain.

## Seed Phase

- Create one deterministic 1,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add an eight-level formula chain where each level adds one to the preceding
  field, then verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Verify all source and formula values are in the baseline state.
2. Start read-only sampling of `computed_update_outbox` for the case table.
3. Update `A` on all 1,000 records in one external bulk-record request.
4. Poll the real records API until all eight formula levels are correct for all
   records and the scoped Outbox is drained.
5. Assert that V2 hybrid exposed at least one Outbox task and ended with no
   pending, processing, or dead-letter task; V1 remains the no-Outbox control.
6. On a reusable local database, restore `A` and verify the baseline chain.

## Primary Metric

- `computedOutboxPropagationReadyMs`: bulk update request plus complete formula
  readiness and scoped Outbox drain.

The initial `maxMs` is 60,000 ms. It is intentionally wider than the depth-four
control until real local and CI timings establish a stable band.

## Notes

V2 hybrid bulk writes enqueue the seed payload before dependency planning. This
case therefore compares Worker depth and drain time against the depth-four
baseline; it does not claim that the legacy synchronous dirty budget caused the
initial task.
