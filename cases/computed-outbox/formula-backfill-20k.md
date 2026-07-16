---
owner: backend-v2
tags:
  - computed
  - outbox
  - formula
  - backfill
  - 20k
  - v1-v2
enabled: true
---

# computed-outbox/formula-backfill-20k

## Goal

Measure formula-field creation on a populated 20,000-row table and prove that
V2 hybrid uses a Computed Outbox field-backfill task once the table-size
estimate is beyond the current 10,000-row asynchronous threshold.

## Seed Phase

- Create one deterministic 20,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields only; the measured formula does
  not exist in the reusable seed.
- Verify the row-count boundary and deterministic source samples.
- Cache the source table and records by the runner seed hash.

## Execute Phase

1. Verify the source-only table is ready.
2. Start read-only sampling of `computed_update_outbox` for the case table.
3. Create formula `F1 = A + 1` through the external field API.
4. Poll the real records API until all 20,000 formula values are correct and
   the scoped Outbox is drained.
5. Assert that V2 hybrid exposed a `field-backfill` Outbox task and ended with
   no pending, processing, or dead-letter task; V1 is the synchronous control.
6. Delete the execute-created formula field on reusable local databases.

## Primary Metric

- `computedOutboxBackfillReadyMs`: formula-field creation plus complete value
  readiness and scoped Outbox drain.

The initial `maxMs` is 120,000 ms. It is a correctness-first guardrail to be
tightened after local and CI measurements.

## Notes

The production decision uses PostgreSQL's row-count estimate rather than an
exact `COUNT(*)`. The case uses 20,000 rows instead of 10,001 to stay clearly
above the threshold under normal statistics lag, and records whether the
expected `field-backfill` task was actually observed.
