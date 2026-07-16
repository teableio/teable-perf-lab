---
owner: backend-v2
tags:
  - computed
  - outbox
  - formula
  - propagation
  - control
  - v1-v2
enabled: true
---

# computed-outbox/formula-chain-update-1k-depth4

## Goal

Measure the baseline V2 hybrid seed-task path: one external bulk update of
1,000 records beneath a four-level same-table formula chain is durably queued
before the Worker plans and executes the computed dependency graph.

## Seed Phase

- Create one deterministic 1,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add a four-level formula chain where each level adds one to the preceding
  field, then verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Verify all source and formula values are in the baseline state.
2. Start read-only sampling of `computed_update_outbox` for the case table.
3. Update `A` on all 1,000 records in one external bulk-record request.
4. Poll the real records API until all four formula levels are correct for all
   records and the scoped Outbox is drained.
5. Assert that V2 hybrid exposed a `seed` Outbox task and drained it without a
   dead letter; V1 is the no-Outbox engine control.
6. On a reusable local database, restore `A` and verify the baseline chain
   before preserving the cached fixture.

## Primary Metric

- `computedOutboxPropagationReadyMs`: bulk update request plus complete formula
  readiness and scoped Outbox drain.

The initial `maxMs` is 30,000 ms. It is a coarse first-run guardrail and should
be tightened after local and CI history exists.

## Notes

Current V2 hybrid bulk writes enqueue minimal `seed` tasks before plan
construction, so task creation does not depend on the older synchronous dirty
budget. Formula depth controls Worker execution cost after dequeue. The observer
samples the durable database ledger read-only and never retries or mutates tasks.
