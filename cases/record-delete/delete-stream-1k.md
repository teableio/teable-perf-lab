---
owner: backend-v2
tags:
  - record-delete
  - stream
  - selection
  - delete
  - 1k
  - 20fields
  - mixed-fields
  - v2
enabled: true
---

# record-delete/delete-stream-1k

## Goal

Measure V2 durable selection deletion of every record in a 1,000-row,
20-field table, from operation creation through terminal success and settled
effects. The historical case ID is retained; V1 is explicitly skipped without
a performance measurement.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the sync record-delete shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 1,000 deterministic records in one 1,000-record batch.
- Uses a plain grid view with no sort, filter, or group;
  `selection: { kind: "all" }` selects the whole view without a record-ID list.
- Verifies the source table is ready by full-scanning 1,000 records and checking
  the expected row count (`seedReady` phase).
- Reuses the shared record-trash fixture family, with a runner-owned seed hash
  and readiness validation before execute.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may delete local rows without repairing the shared seed dump.

## Execute Phase

1. For an engine other than V2, return `skipped` with `metrics: {}` and
   `thresholds: []` before fixture preparation or mutation lifecycle work.
2. Prepare the source table, complete `seedReady`, and retain real record IDs
   from the readiness scan for later cleanup, outside the primary timer.
3. Start the primary timer before creating the operation with
   `POST /api/table/{tableId}/selection/delete-operations` and body
   `{ operationId: <UUID>, viewId, selection: { kind: "all" } }`.
4. Assert V2 routing with feature `deleteRecord`. Creation is execution;
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}/stream`
   observes snapshots until terminal state, without executing deletion.
5. Confirm durable state with
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}`. After
   `status: "succeeded"`, wait for `effectsStatus: "settled"`,
   `pendingEffectCount: 0`, and `failedEffectCount: 0` before stopping the timer.
6. Independently scan the table and assert zero visible records, outside the
   timer. A stream close alone is not proof of success; a nonterminal status
   fails observation and never starts a second deletion.
7. Cleanup uses the pre-mutation known IDs to locate existing record-trash
   items, restore them, and verify reusable shared fixtures. Standalone isolated
   execute databases may be discarded; nonreusable fixtures are removed.

## Primary Metric

- `deleteStream1kMs`: total elapsed time from before POST creation until durable
  success and effects readiness, under
  `timingProfile: "v2-durable-delete-total-ready"`.

This profile includes create latency, worker/scheduler execution, observation,
status reads, and waiting for settled effects. It excludes seed preparation,
pre-delete readiness scans, the actual post-delete empty-table scan, cleanup,
and seed-cache restore/build work. The metric name and configured threshold
remain unchanged, but this is not the old stream-`done` timing boundary.

## Verification

- The final snapshot must have `totalCount`, `processedCount`, and
  `deletedCount` equal to 1,000, with `failedCount: 0` and no operation error.
- `status` must be `succeeded`; `effectsStatus` must be `settled`, with zero
  pending and failed effects. Terminal deletion alone is insufficient.
- The table must contain no visible records after the independent scan.
- V2 routing is required; V1 produces only an explicit skip, never V1 timings.

## Notes

`record-delete/delete-1k` remains the separate synchronous-delete benchmark.
The retained `delete-stream` ID does not imply the removed stream mutation
protocol: this runner consumes bounded operation snapshots, not a full success
ID array or a deleted-ID completion payload.

Trace steps distinguish `<metric>-create-execution` from
`<metric>-observe-readonly` and `<metric>-status-readonly`. Read-only observer
latency is not labeled as mutation execution, but remains in total-ready time.

For historical V1/V2 wire baselines and exact workflow parameters, see
[the durable-delete reproduction procedure](../../docs/operations/teable-ee-e2e.md#durable-delete-baseline-and-candidate-runs).
Only pinned old refs run the old mutation streams; this checkout never measures
same-head V1 for this case.
