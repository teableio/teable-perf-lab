---
owner: backend-v2
tags:
  - record-delete
  - stream
  - selection
  - 30k
  - v2
enabled: true
---

# record-delete/delete-stream-30k

## Goal

Extend the V2 durable selection-delete curve to a 30,000-row mixed table,
measuring operation creation through terminal success and settled effects.
The historical case ID is retained; V1 is skipped without measurement.

## Seed Phase

Create one deterministic 30,000-row, 20-field mixed table in 1,000-row batches.
Full-scan readiness and verify first, middle, and last sample values before
execute; capture real record IDs before mutation for existing trash cleanup.

## Execute Phase

1. Skip V1 before fixture/lifecycle work with `metrics: {}` and `thresholds: []`.
2. Once the fixture is ready, start the primary timer before
   `POST /api/table/{tableId}/selection/delete-operations`, with body
   `{ operationId: <UUID>, viewId, selection: { kind: "all" } }`.
3. Require V2 feature `deleteRecord` routing. Observe bounded snapshots through
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}/stream`
   until terminal state; this GET is read-only, not mutation execution.
4. Confirm status through
   `GET /api/table/{tableId}/selection/delete-operations/{operationId}` and wait
   for `status: "succeeded"`, `effectsStatus: "settled"`,
   `pendingEffectCount: 0`, and `failedEffectCount: 0` before stopping the timer.
5. Independently scan for an empty table outside the timer. Stream EOF alone
   cannot pass; nonterminal status fails observation without another POST.
6. Use the pre-mutation known IDs for existing trash restore cleanup of reusable
   fixtures. Standalone isolated execute databases may instead be discarded;
   nonreusable fixtures are removed.

## Primary Metric

- `deleteOperationTotalReady30kMs`: before POST creation through durable success
  and settled effects, under `timingProfile: "v2-durable-delete-total-ready"`.

The profile includes create, worker/scheduler execution, observer/status reads,
and effects settlement. Seed/cache work, pre-delete readiness, the actual final
empty-table scan, and cleanup are excluded. The numeric threshold is unchanged;
the new metric name prevents automated comparison with historical
`deleteStream30kMs` stream-`done` timings. A new durable-metric release baseline
is required.

## Verification

- Routing must be V2 with feature `deleteRecord`; V1 has no measured result.
- Final `totalCount`, `processedCount`, and `deletedCount` must equal 30,000,
  with `failedCount: 0` and no operation error.
- Require succeeded status, settled effects, and zero pending/failed effects.
- The independent verification scan must find zero visible records.

## Notes

Only row scale changes from the 10k sibling. Snapshots report counts/state, not
a full success-ID array. Trace steps distinguish `<metric>-create-execution`
from `<metric>-observe-readonly` and `<metric>-status-readonly`.

Use [the durable-delete reproduction procedure](../../docs/operations/teable-ee-e2e.md#durable-delete-baseline-and-candidate-runs)
for pinned historical V1/V2 baselines and the V2-only candidate. No same-head
V1 measurement exists for this runner.
