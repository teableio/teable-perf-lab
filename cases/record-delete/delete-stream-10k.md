---
owner: backend-v2
tags:
  - record-delete
  - stream
  - selection
  - delete
  - 10k
  - 20fields
  - mixed-fields
  - v2
enabled: true
---

# record-delete/delete-stream-10k

## Goal

Measure V2 durable selection deletion of every record in a 10,000-row,
20-field table, from operation creation through terminal success and settled
effects. This is the 10x-scale sibling of `record-delete/delete-stream-1k`;
the historical case ID is retained, and V1 is skipped without measurement.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the sync record-delete shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Inserts 10,000 deterministic records in ten 1,000-record batches.
- Uses a plain grid view with no sort, filter, or group; the operation selects
  the whole view with `selection: { kind: "all" }`, not a record-ID list.
- Verifies the source table is ready by full-scanning 10,000 records and checking
  the expected row count (`seedReady` phase).
- Reuses the shared record-trash fixture family, with a runner-owned seed hash
  and readiness validation before execute.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may delete local rows without repairing the shared seed dump.

## Execute Phase

1. Return an explicit `skipped` result for V1 with `metrics: {}` and
   `thresholds: []`, before fixture preparation or mutation lifecycle work.
2. Prepare the source table and complete `seedReady`. Keep real record IDs from
   the pre-mutation readiness scan for cleanup, outside the timer.
3. Start the primary timer before
   `POST /api/table/{tableId}/selection/delete-operations` with body
   `{ operationId: <UUID>, viewId, selection: { kind: "all" } }`.
4. Require V2 routing and feature `deleteRecord`. Observe snapshots through
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}/stream`
   until terminal state. The observer is read-only; POST creation starts work.
5. Confirm state with
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}` and wait
   for `status: "succeeded"`, `effectsStatus: "settled"`,
   `pendingEffectCount: 0`, and `failedEffectCount: 0`. Stop the timer only then.
6. Full-scan for zero visible records outside the primary timer. Stream EOF is
   not success; a nonterminal status fails observation without reissuing POST.
7. Cleanup locates existing record-trash items using pre-mutation known IDs and
   restores/verifies reusable shared fixtures. Standalone isolated execute DBs
   may be discarded; nonreusable fixtures are removed.

## Primary Metric

- `deleteOperationTotalReady10kMs`: before POST creation through durable success
  and settled effects, using `timingProfile: "v2-durable-delete-total-ready"`.

Total-ready time includes create, worker/scheduler execution, observer and
status requests, and effects settlement. Seed build, readiness and ID scans,
the actual empty-table verification scan, cleanup, and cache restore are
outside the primary timer. The numeric threshold is retained; the new metric
name prevents automated comparison with historical `deleteStream10kMs`
stream-`done` timings. A new durable-metric release baseline is required.

## Verification

- Final `totalCount`, `processedCount`, and `deletedCount` must be 10,000;
  `failedCount` must be zero and no operation error may be present.
- Require `status: "succeeded"`, `effectsStatus: "settled"`, and zero pending
  and failed effects, not merely terminal deletion.
- The independent scan must find no visible records.
- V2 routing is mandatory; V1 returns only a skip with no measurement.

## Notes

Operation snapshots carry counts and state, not a full success-ID array. Trace
steps separate `<metric>-create-execution`, `<metric>-observe-readonly`, and
`<metric>-status-readonly`; observation does not execute the mutation, even
though its elapsed time is included in total-ready timing.

See [the durable-delete reproduction procedure](../../docs/operations/teable-ee-e2e.md#durable-delete-baseline-and-candidate-runs)
for the pinned old V1/V2 wire baselines and V2-only candidate workflow. Do not
run same-head V1 as a baseline or mix old and new timing profiles as equivalent
latency measurements.

Use the existing isolated CI database/bootstrap rather than a shared CLOUD
space. Seeding quota failures and transaction timeouts require diagnosis; they
are not evidence of successful durable-delete execution.
