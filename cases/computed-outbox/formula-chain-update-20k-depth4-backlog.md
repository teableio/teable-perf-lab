---
owner: backend-v2
tags:
  - computed
  - outbox
  - formula
  - propagation
  - backlog
  - scale
  - v1-v2
enabled: true
---

# computed-outbox/formula-chain-update-20k-depth4-backlog

## Goal

Measure whether one 20,000-record source update beneath a four-level formula
chain creates a visible V2 hybrid Computed Outbox backlog, then prove that the
Worker catches up, the queue drains without dead letters, and every computed
value becomes correct.

## Seed Phase

- Create one deterministic 20,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add a four-level formula chain where each level adds one to the preceding
  field, then verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Verify all source and formula values are in the baseline state.
2. Start read-only sampling of `computed_update_outbox` for the case table.
3. Update `A` on all 20,000 records in one external bulk-record request.
4. Poll the real records API until all four formula levels are correct for every
   row and the scoped Outbox is drained.
5. Assert that V2 hybrid exposed a `seed` backlog with at least two pending
   tasks at peak and ended with no task or dead-letter residue; V1 remains the
   no-Outbox control.
6. On a reusable local database, restore `A` and verify the baseline chain.

## Primary Metric

- `computedOutboxPropagationReadyMs`: bulk update request plus complete formula
  readiness and scoped Outbox drain.

The initial `maxMs` is 180,000 ms. It is a correctness-first guardrail to be
tightened after repeated CI runs establish the backlog case's stable range.

## Notes

This is a backlog-pressure case, not a fault-injection case. It scales the
healthy path enough to observe pending work, maximum oldest-task age, observed
task lifetime, peak task counts, and time to drain. If 20,000 rows cannot
produce `peakPending >= 2` on the normal Worker, the case should not be kept in
the default CI plan merely by increasing the data size again.
