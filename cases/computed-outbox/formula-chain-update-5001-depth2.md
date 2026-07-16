---
owner: backend-v2
tags:
  - computed
  - outbox
  - formula
  - propagation
  - threshold
  - v1-v2
enabled: true
---

# computed-outbox/formula-chain-update-5001-depth2

## Goal

Measure the V2 hybrid task-splitting path caused by one bulk user write carrying
5,001 seed records, one record beyond the current 5,000-record maximum per
Outbox task, while keeping the same-table formula chain only two levels deep.

## Seed Phase

- Create one deterministic 5,001-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add a two-level formula chain where each level adds one to the preceding
  field, then verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Verify all source and formula values are in the baseline state.
2. Start read-only sampling of `computed_update_outbox` for the case table.
3. Update `A` on all 5,001 records in one external bulk-record request.
4. Poll the real records API until both formula levels are correct for all rows
   and the scoped Outbox is drained.
5. Assert that V2 hybrid exposed at least one Outbox task and ended without a
   dead letter; V1 remains the no-Outbox control.
6. On a reusable local database, restore `A` and verify the baseline chain.

## Primary Metric

- `computedOutboxPropagationReadyMs`: bulk update request plus complete formula
  readiness and scoped Outbox drain.

The initial `maxMs` is 120,000 ms and is deliberately coarse until repeated CI
runs calibrate the 5,001-record split boundary.

## Notes

The OpenAPI bulk-update schema has no 1,000-record array cap, so this case keeps
all 5,001 changes in one request. The V2 hybrid writer first enqueues one `seed`
task; the Worker must split that payload because it exceeds
`maxSeedRecordsPerTask=5000`. The observer records peak task counts and drain
time without mutating the queue.
