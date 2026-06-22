# Spec: add a streaming-delete selection case (v1 range-stream / v2 by-id-stream)

Self-contained brief for the next agent. You should not need any prior chat to
do this. Read `.agents/README.md` first (the add-a-case playbook), then this.

## Goal

Add the missing 4th selection-stream perf case: **deleting a large selection
through the streaming delete path**. It must compare the _same UI behavior_
across engines, each engine using the endpoint its own grid uses:

- **V1**: `GET /api/table/{tableId}/selection/delete-stream` (range, legacy
  stream — has a community/V1 implementation).
- **V2**: `PATCH /api/table/{tableId}/selection/delete-by-id-stream` (by-id
  stream — `recordV2Service.deleteByIdStream`).

This is a real V1/V2 comparison (NOT a V2-only case), because the behavior
exists on both engines through their respective stream endpoints.

## Why this case (context)

PR #70 (merged 2026-06-22, commit c182a6c9) migrated the selection cases to
"compare the same UI behavior, v1 range / v2 by-id". After that, the four grid
selection stream operations are covered like this:

| op         | v1 leg             | v2 leg                | case                           |
| ---------- | ------------------ | --------------------- | ------------------------------ |
| clear      | `clear-stream`     | `clear-by-id-stream`  | selection-clear/flat-1k-... ✅ |
| paste      | `paste-stream`     | `paste-by-id-stream`  | selection-paste/10k-expand ✅  |
| duplicate  | `duplicate-stream` | (no by-id variant)    | record-duplicate/grid-block ✅ |
| **delete** | `delete-stream`    | `delete-by-id-stream` | **MISSING — this spec**        |

The product streams any selection delete with >200 effective rows
(`grid/utils/selection.ts` `DELETE_SELECTION_STREAM_ROW_THRESHOLD = 200` in
teable-ee). The existing `record-delete/delete-1k` measures the **sync** delete
(`DELETE /selection/delete` v1 / `POST /selection/delete-by-id` v2), which is
the small-selection path — it does NOT exercise the streaming delete that the UI
actually uses for a 1k-row delete. This case fills that gap.

Keep `record-delete/delete-1k` as-is; add a new streaming case alongside it.

## Runner

Do NOT extend the sync `record-delete` runner (it rides the record-replay
lifecycle with the sync delete; a stream branch would distort it). Add a thin
new stream runner that **mirrors `selection-clear`** — that runner already does
exactly the shape you need: seed a mixed table, drive a `*-stream` endpoint via
`perfStreamSse` with per-engine url+body dispatch, assert the done event, assert
routing, verify final state, cleanup. Copy its structure.

Reference files to copy/adapt (all on `main` after PR #70):

- `framework/runners/selection-clear.runner.ts` — the template: see
  `clearAllCells` for the `const isV2 = context.engine === "v2"` url+body
  dispatch and `buildAllCellsByIdBody`. Your delete equivalent dispatches:
  - v1: `GET /selection/delete-stream` (range). Range body shape = same as the
    sync delete's range (rows range over the view); see
    `record-replay.shared.ts` `buildAllRowsRange` / `buildUiSelectionDeleteRange`
    for the range shape, and the openapi `deleteSelectionStream` client
    (`packages/openapi/src/selection/delete-stream.ts`, GET with query params).
  - v2: `PATCH /selection/delete-by-id-stream` with body
    `{ selection: { allRecords: true } }` (selectionIdsRoSchema). Use
    `allRecords: true` — do NOT pass explicit recordIds (see gotcha #1).
- `cases/record-duplicate/grid-block-duplicate-1k.case.ts` — the scale template:
  a 1k block in a 10k mixed table, driven through a selection stream.
- The delete stream event type is `IDeleteSelectionStreamEvent` (done/progress/
  error) from `@teable/openapi`; the by-id stream reuses the SAME type, so
  done-event parsing is identical for both engines. The done event carries
  `deletedCount` and `data.deletedRecordIds`.
- Routing: use `assertEngineRouting(context, headers, { operation: "deleteSelectionStream", feature: "deleteRecord" })`. Both legs are `@UseV2Feature('deleteRecord')`, so v1→`x-teable-v2=false`, v2→`x-teable-v2=true`.

Because this is a NEW runner kind, follow `.agents/new-runner-contract.md`:
add it to `PerfCaseConfigByRunner` in `framework/types.ts`, register it in
`framework/runner-registry.ts`, and give it a seed entry. The seed/fixture can
reuse the mixed-20-field shape + `flat-table-operation` generator that
selection-clear / grid-block-duplicate use.

## Seed phase

A 10,000-row, 20-mixed-field table (copy the field list + `flat-table-operation`
generator from `cases/record-duplicate/grid-block-duplicate-1k.case.ts` or
`cases/selection-clear/flat-1k-20fields-cell-clear-stream.case.ts`). This is a
destructive case (delete), so execute runs against the isolated execute DB and
may mutate it. The seed should be cache-aware like selection-clear.

## Execute phase

1. Seed ready (10k rows present).
2. Measured op: drive the streaming delete of a 1,000-row block (or all rows —
   see open assumption) via `perfStreamSse`, engine-dispatched (v1 range
   `delete-stream`, v2 `delete-by-id-stream`). Read to the `done` event.
3. Assert business success: `errors` empty, `done.deletedCount === <expected>`,
   `done.data.deletedRecordIds.length === <expected>`.
4. Assert routing per engine (see above).

Start the primary timer only at the stream call, not the seed.

## Primary metric

`deleteStream1kMs` (or `deleteBlockStream1kMs`), proposed `maxMs` ~120_000 as a
loose initial guardrail (the v1 legacy delete-stream can be slow; tighten after
CI history — e.g. PR #70's paste-stream cases showed v1 ~19–20s, v2 ~6s for 10k,
so a 1k delete should be well under 120s). Mark as an assumption.

## Verification

Full paged scan of the final state: if deleting a 1k block of a 10k table,
verify final count == 9,000 and the deleted block's rows are gone (sample +
count scan). If deleting all of a 1k table, verify empty.

## Critical gotchas (learned the hard way in PR #70)

1. **Seed-cache hit hydrates `seededRecords` with synthetic EMPTY recordIds**
   (only the row COUNT is restored, not real ids). So the by-id selection MUST
   NOT depend on `recordIds`. Use `selection: { allRecords: true }` for "delete
   all", or `excludeRecordIds: []` for the whole query scope. `fieldIds` /
   `projection` are real on a cache hit (from getFields), but delete doesn't
   need fields anyway. If you delete a _block_ (not all), you cannot rely on
   recordIds across a cache hit — prefer cache-DISABLED for a block variant, or
   delete-all to stay robust.
2. **HTTP method differs per leg**: v1 `delete-stream` is **GET** (ranges in
   query params — see the SDK `deleteSelectionStream` `buildDeleteSelectionStreamParams`);
   v2 `delete-by-id-stream` is **PATCH** with a JSON body. `perfStreamSse`
   supports both; build the GET url with query params for v1, JSON body for v2.
3. **Routing feature is `deleteRecord`** for both range and by-id delete.
4. **The 402 row-quota guard does NOT apply here.** That guard
   (`usage-cloud.service.ts checkUsageOverLimit(MaxRows)`) is only on the v1
   **sync range paste** path; delete (any) and all stream paths skip it.
5. **Local v1 large ops can fail environmentally** (402 from a polluted CLOUD
   test space, or 408 Prisma transaction timeout on huge sync ops). Streaming
   delete should avoid the big-transaction 408 (it batches), but if a v1 leg
   misbehaves locally, confirm on CI (isolated DB) before treating it as a code
   bug. See memory `perf-lab-sandbox-row-quota-402`.

## Workflow (deliverable bar)

1. `cases/record-delete/<name>.case.ts` + same-name `.md` (frontmatter + Goal /
   Seed Phase / Execute Phase / Primary Metric / Verification / Notes; in Notes
   document the per-engine dispatch like the PR #70 cases do).
2. Register in `registry.ts` (import + `cases` array entry).
3. `pnpm sync:readme` then `pnpm check` (must be green).
4. Local v1+v2 run (see `.agents/skills/localrun/SKILL.md`): refresh sandbox →
   `pnpm install` in sandbox if deps changed → inject → run with
   `PERF_LAB_ENGINE_LIST=v1,v2`. Verify both engines: `result: pass`, routing
   matches engine, full-scan evidence == expected, metric well under `maxMs`.
5. Official acceptance via GitHub Actions (the trigger + inputs are in
   `docs/operations/teable-ee-e2e.md`; `case_filter` accepts a single id).

## Open assumptions to confirm with the user

- **Scale/shape**: 1k block in a 10k table (parallels grid-block-duplicate,
  stronger verification, but block + cache-hit-empty-ids interact — see gotcha
  #1, may need cache-disabled) **vs** delete-all of a 1k table (simpler, robust
  to cache hit via `allRecords`, parallels the existing sync delete-1k). Default
  to delete-all-of-1k for robustness unless the user wants the 10k block.
- Metric name + `maxMs`.
- Case id, e.g. `record-delete/delete-stream-1k` (or `-block-1k`).
