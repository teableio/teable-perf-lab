# Implementation Checklist

Hard rules to honor while writing a case or runner. Violating these produces
wrong or non-comparable metrics.

## Metric Boundaries

- The primary metric measures the operation + its readiness, not setup.
- Keep seed/fixture build out of the primary metric unless the case is explicitly
  measuring setup.
- Record setup durations (`createTableMs`, `seedRecordsMs`, `maxSeedBatchMs`,
  etc.) as diagnostic metrics. They explain noisy runs; they do not enter the
  primary metric.
- Start the primary timer only after the seed fixture is verified ready.

## Deterministic Data

- Data must be computable from the row number and config, so the runner can
  derive expected values locally and V1/V2 + reruns compare.
- Formula rows use a numeric sequence; expected values are computed locally
  (e.g. `({A} * {B}) + {C}`).
- Conditional-lookup rows use a permutation
  `sourceRow = ((hostRowOffset * multiplier + offset) % recordCount) + 1`. The
  `multiplier` must be coprime with `recordCount` so each host row maps to a
  unique source row — that lets a full scan prove every row got a distinct value.
- Seed in batches (e.g. 10k rows at `batchSize` 1000); record batch timings as
  setup phases. Keep only the sample ids needed for validation, not all rows.

## Verification

Two levels, both required for a meaningful pass:

- **Sample**: quick polling on a few known rows to confirm correct values start
  appearing.
- **Full scan**: paged read of every row through the real read path
  (`getRecords`, usually 1000 at a time) to prove the operation fully landed.

On failure, throw a diagnostic result that still carries completed phase
durations, table/field ids, sample records, partial metrics, and the error — so a
developer can see whether setup, trigger, polling, full scan, or cleanup failed.

Wrap important axios phases with `withPerfTraceStep()` so trace artifacts align
with case phases. For raw `fetch` / SSE calls, use the repository's perf SSE
helper so perf trace headers are sent and response `traceparent` refs are
captured.

## Stateful Stream Requests

For any case whose measured request depends on server-side state from earlier
requests (clear streams, delete, undo, redo):

- First decide whether the measured request depends on state created by setup.
- If a request chain depends on the same operation history, every related request
  must share the same context identifier.
- Context identifiers usually belong in headers, not query strings or bodies. For
  record history streams, use the same `X-Window-Id` across the dependent chain.
- Setup streams must fully finish before the measured stream starts.
- Do not treat HTTP `200` as completion. Read the stream until its final
  completion event.
- If the final event has a business status field, assert success before the next
  phase.
- For selection / range requests, verify `viewId`, `ranges`, optional `type`,
  and optional `projection[]` match the seeded view.
- Wrong affected-row count? Check seed count, range boundaries, view
  sort/filter/group state, and projected field ids first.
- A dependent request can't find prior state? Check table id, authenticated
  session, shared context identifier, and whether the preceding stream actually
  completed.
- Verify final table state through reads; do not rely only on a stream success
  event.

## Selection Clear Stream Specifics

The product uses `PATCH /api/table/{tableId}/selection/clear-stream` when a
selection affects more than 200 rows. For a full-table cell clear, use the
grid-UI cell-range payload:

```json
{
  "viewId": "viw...",
  "ranges": [
    [0, 0],
    [19, 9999]
  ],
  "projection": ["fld...", "fld..."]
}
```

`projection` is the visible field id list in view order. `ranges[1][0]` is
`projection.length - 1`; `ranges[1][1]` is `rowCount - 1`. Do **not** add
`type:"rows"` for cell-clear. The endpoint returns `text/event-stream`; record
compact metrics from the parsed `done` event and verify with a paged record
scan.

## Selection Delete Specifics

The grid delete path used by `record-delete`, `record-undo`, and `record-redo`
is synchronous:

```http
DELETE /api/table/{tableId}/selection/delete
```

For the 1k full-table delete cases, use the UI-shaped cell range:

```json
{
  "viewId": "viw...",
  "ranges": [
    [0, 0],
    [0, 999]
  ]
}
```

Keep the same `X-Window-Id` across delete, undo, redo, and cleanup restore
requests that belong to the same operation chain. Capture routing headers such
as `x-teable-v2`, `x-teable-v2-feature`, and `x-teable-v2-reason` from the
delete response.
