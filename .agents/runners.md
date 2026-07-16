# Runner Catalog & Decision

A runner is the reusable execution shape. The case config feeds it. Runner kinds
are defined in `framework/types.ts`; implementations live in
`framework/runners/*.runner.ts`.

Before hand-rolling a new runner, prefer riding a lifecycle driver
(`framework/runners/*-lifecycle.ts` — e.g. `record-mutation-lifecycle`,
`read-lifecycle`, `field-add-lifecycle`) that owns the seed/execute/verify/cleanup
protocol, and reuse the shared helpers in `framework/`: `metrics.ts`
(`measureAsync`/`Measurement`), `readiness.ts` (`pollUntilReady`/`sleep`),
`record-page-scan.ts` (`forEachRecordPage`), `sample-records.ts`
(`collectSampleRecords`), and `chunk.ts` (`chunk`).

## Decision Order

```text
reuse existing runner -> extend a runner -> new runner
```

1. **Reuse** if an existing runner already performs the operation; only the
   config changes (row count, fields, table name, threshold).
2. **Extend** a runner when the operation is the same family but the current
   config cannot express it. Add the config option and the behavior; do not break
   existing cases that use that runner.
3. **New runner** only when extending would distort an existing runner. If this
   is unavoidable, follow [new-runner-contract.md](new-runner-contract.md) for
   wiring, result shape, diagnostics, traces, seed cache, verification,
   thresholds, and cleanup.

## Catalog

| Runner                      | Measures                                                                                | Use when                               |
| --------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `http-endpoint`             | repeated requests to one authenticated endpoint, p95                                    | simple GET latency, smoke timing       |
| `formula-table`             | create table + numeric rows, add formula field(s), wait until computed                  | formula / computed-field readiness     |
| `conditional-lookup`        | source + host tables, add conditional lookup, verify values                             | lookup / cross-table computed fields   |
| `conditional-rollup`        | source + host tables, add conditional rollup, verify aggregated values                  | conditional cross-table aggregation    |
| `conditional-query`         | grouped source + host tables, add lookup/rollup with fanout/filter/sort/limit           | conditional query configuration matrix |
| `link-computed-propagation` | mutate links in a four-table lookup/formula/rollup graph and await configured readiness | link write-to-computed readiness       |
| `computed-chain-mutation`   | edit one formula or foreign cell in a 40-user/4k-order/400-purchase depth-5 graph       | data and dependency-graph cascades     |
| `lookup-search-index`       | source + host lookup tables, search index on/off, repeated global search-index requests | lookup global search with table index  |
| `field-create`              | empty table, create one field, verify field metadata                                    | field metadata creation                |
| `field-duplicate`           | source + host conditional lookup tables, create lookup setup, duplicate lookup field    | field metadata/data duplication        |
| `duplicate-base`            | seeded multi-table base, duplicate/export base, verify copied records/link/workflows    | duplicate/export whole-base behavior   |
| `import-base`               | seeded source base, export/upload as setup, import `.tea` through SSE, verify tables    | whole-base import behavior             |
| `csv-import`                | empty table, upload CSV, import into existing table, verify records                     | CSV import into an existing table      |
| `record-paste`              | empty table, paste deterministic clipboard content via paste API                        | paste / bulk insert through selection  |
| `record-create`             | empty mixed table, create typed records through OpenAPI                                 | direct bulk record create              |
| `record-update`             | seeded mixed table, update typed records through OpenAPI                                | direct bulk record update              |
| `record-reorder`            | seeded mixed table, move a visible record block through OpenAPI                         | manual row order mutation              |
| `selection-clear`           | seeded table, call selection clear stream, verify cells empty                           | clearing a large cell range            |
| `record-delete`             | mixed 1k table, delete all rows via selection delete                                    | row delete throughput                  |
| `record-undo`               | delete as setup, then measure undo-stream                                               | undo replay                            |
| `record-redo`               | delete + undo as setup, then measure redo-stream                                        | redo replay                            |

## Config Shapes

The exact interfaces are in `framework/types.ts`. Key fields per runner:

- **http-endpoint**: `method:"GET"`, `path`, `samples`, `threshold{metric:"p95Ms",maxMs}`, optional `validateSeedUser`.
- **formula-table**: `baseId:"seed-base"`, `tableNamePrefix`, `recordCount`, `batchSize`, `fields[]`, `generator{type:"numeric-sequence",titlePrefix}`, `formula` or `formulas[]`, `verify{sampleRows,...}`, `threshold{metric:"formula(s)(Full)ReadyMs",maxMs}`.
- **conditional-lookup**: source/host prefixes, `recordCount`, `batchSize`, `generator{type:"permuted-unique-key-sequence",...,permutation{multiplier,offset}}`, `lookup{name,limit}`, `verify`, `threshold{metric:"conditionalLookupReadyMs"}`. The `permutation` has a coprime constraint — see Deterministic Data in [checklist.md](checklist.md).
- **conditional-rollup**: the same deterministic source/host seed shape as `conditional-lookup`, plus `rollup{name,expression:"array_join({values})",limit}`, `verify`, `threshold{metric:"conditionalRollupReadyMs"}`. The paired 10k cases share one synthetic seed identity but measure and verify their field types independently.
- **conditional-query**: grouped source/host fixture, `sourceRecordCount`, `hostRecordCount`, `groupCount`, `field{kind:"lookup"|"rollup",valueField,filter,expression?,sort?,limit?}`, optional `mutation{kind,recordCount,...}`, `verify`, and either `threshold{metric:"conditionalQueryReadyMs"}` for field creation or `threshold{metric:"conditionalQueryPropagationReadyMs"}` for source-update propagation. `conditional-query-workload.ts` owns the deterministic grouped-fanout algebra, seed rows, mutation targets, expected values, and shape metrics; the runner keeps Teable I/O. Creation rides `field-add-lifecycle`, while propagation rides `record-mutation-lifecycle`. Use it for fanout, multi-filter, value-type, aggregation, sort/limit, controlled calculation-volume curves, and deterministic source-mutation curves. Propagation cases create and verify the field as setup, then measure one bulk source-update request plus full host readiness; the backend may still chunk storage work internally. The paired 10k/30k-host curves keep a 1k-record request fixed to isolate downstream calculation growth. All configs with the same seed shape share one fixture, and mutation cleanup restores it between cases. Result details expose group matches, retained values, mutation size, affected rows, and update request count.
- **link-computed-propagation**: four-table customer-shaped fixture with `rowCount`, `foreignRowCount`, dual link permutations, `purchase.groupSize`, and `mode:"first-link"|"repoint"`. Omit `mutation` for the existing all-order write, or set `mutation{startOffset?,recordCount}` for a deterministic partial write. `verify.readinessReadPath` defaults to `full-scan`; `get-record` and `get-records` poll only the mutated records inside `lookupPropagationMs`, then run the full orders + purchase cascade verification outside the primary timer. The pure partial-state/readiness rules live in `link-computed-propagation-workload.ts`; the runner owns Teable I/O and cleanup through `record-mutation-lifecycle`.
- **computed-chain-mutation**: deterministic Users -> Orders -> Purchases fixture with `userCount`, `orderCount`, `ordersPerUser`, `purchaseGroupSize`, and `targetUserRow`. `mutation` selects one head-formula update (dependency ids unchanged, added, replaced, or removed) or one foreign Status/first-name cell update. Formula updates wait for the full graph inside `fullCascadeReadyTotalMs` and expose exact added/removed dependency ids; foreign-cell cases stop `firstOrderReadyTotalMs` on the first direct order read, then full-scan all affected and control rows outside the primary timer. `computed-chain-mutation-model.ts` owns fanout, dependency-diff, and literal expectations; the runner uses `record-mutation-lifecycle` for seed/execute/cleanup.
- **lookup-search-index**: source/host prefixes, `tableIndexMode:"off"|"on"`, `recordCount`, `batchSize`, `userCount`, `samples`, `generator{type:"lookup-search-index-20-fields",...,permutation{multiplier,offset}}`, `keywords[]`, `verify`, `threshold{metric:"lookupSearchIndexP95Ms"}`. Seed creates lookup fields and turns table search index on only for the ON host; execute measures repeated `aggregation/search-index` requests for the selected mode only.
- **field-create**: `tableNamePrefix`, `baseFields[]`, `field`, `verify{optionCount,sampleOptionIndexes}`, `threshold{metric:"singleSelectCreateOptionsMs"}`. Seed creates an empty base table; execute creates the configured field and verifies field metadata.
- **field-duplicate**: `sourceTableNamePrefix`, `hostTableNamePrefix`, `recordCount`, `batchSize`, `generator{type:"permuted-unique-key-sequence",...,permutation{multiplier,offset}}`, `lookup{name,limit}`, `duplicate{name}`, `verify`, `threshold{metric:"conditionalLookupDuplicateReadyMs"}`. Seed reuses the conditional lookup 10k table shape; execute creates the source lookup field as setup, duplicates it, then verifies the duplicated lookup values.
- **duplicate-base**: `spaceId:"seed-space"`, `operation:"duplicate"|"duplicate-stream"|"export-stream"`, source `mainTable` / `linkedTable` / `smallTable`, `workflows`, `duplicate{withRecords}`, `verify{mainSampleRows,linkSampleRows,...}`, `threshold{metric:"duplicateBaseRequestMs"|"duplicateBaseStreamMs"|"exportBaseStreamMs"}`. Seed caches the source base; execute duplicates or exports it and verifies records, link remapping, and workflows where applicable.
- **import-base**: V2-only runner with `spaceId:"seed-space"`, `sourceBaseNamePrefix`, generated `tables[]` / `workflows` or `teaFile`, `verify{sampleRows,...}`, `threshold{metric:"importBaseStreamMs"}`. Seed caches the generated source base (or validates the repo `.tea` fixture); execute **re-uploads** the import package fresh (re-export+upload for generated cases, re-read the repo fixture for tea-file cases) and measures `POST /base/import-stream`. The upload cannot be cached across the seed→execute boundary because that boundary only carries the PostgreSQL dump, not the backend `.assets/uploads` directory (the `seed`/`execute` jobs in `.github/workflows/teable-ee-e2e-perf.yml`). V2 stream `done` is the primary completion point; export/upload and post-import full scans are diagnostics outside the metric.
- **csv-import**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-csv-import",titlePrefix,payloadPrefix,valuePrefix}`, `verify`, `threshold{metric:"csvInplaceImportReadyMs"}`.
- **record-paste**: `tableNamePrefix`, `rowCount`, optional `maxPasteCells`, `fields[]`, `generator{type:"flat-copy-paste"|"mixed-copy-paste",titlePrefix,...}`, `verify`, `threshold{metric:"paste10kMs"}`.
- **record-create**: `tableNamePrefix`, `rowCount`, `fields[]`, `generator{type:"mixed-record-create",titlePrefix,payloadPrefix,valuePrefix}`, `verify`, `threshold{metric:"bulkCreate1kMs"}`. The reusable seed is the empty mixed table plus cached typed create payload; execute creates records fresh.
- **record-update**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-record-update",seedPrefix,updatePrefix}`, `verify`, `threshold{metric:"bulkUpdate1kMs"}`. The reusable seed stores deterministic records and cached record ids; non-isolated cleanup restores seed values.
- **record-reorder**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-undo-redo",...}`, `reorder{blockStartOffset,blockSize,anchorOffset,position}`, `verify`, `threshold{metric:"moveLast1kToFrontMs"}`. The reusable seed stores initial order metadata; non-isolated cleanup restores the original order.
- **selection-clear**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"flat-table-operation",titlePrefix,payloadPrefix}`, `verify`, `threshold{metric:"clear1kMs"}`.
- **record-delete / record-undo / record-redo**: share `RecordUndoRedoBaseCaseConfig` (`tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-undo-redo",...}`, `verify`). They differ only in the threshold metric: `delete1kMs` / `undoReplay1kMs` / `redoReplay1kMs`. The shared mixed-record base config is exported as `recordReplay10kBaseConfig` in `framework/runners/record-replay.shared.ts` — spread it and override `rowCount`, `tableNamePrefix`, `verify`, and `threshold` for the 1k cases.

## Fail-Fast Watchdog (opt-in)

Any case can set a top-level `watchdogMs` (sibling of `timeoutMs`) to fail fast
when the server stops responding instead of hanging until the hard `timeoutMs`.
It is an **idle** watchdog (see `framework/watchdog.ts`): the timer trips only
after `watchdogMs` of no HTTP request or SSE event progress, so a healthy run —
which keeps issuing requests / receiving stream events — never trips it. On trip
the case fails with a `perf watchdog: no server activity…` diagnostic and the
case `AbortSignal` (`context.signal`) is aborted.

- Set `watchdogMs` comfortably above the longest single server round-trip a
  healthy run expects (a paged scan, a stream gap, a bulk request). Only true
  silence trips it; it does not need tuning against total run duration.
- SSE streams honor `context.signal` automatically via the perf SSE helper.
  Non-SSE runners that want a hung request actually cancelled should forward
  `context.signal` to axios (e.g. `axios.get(url, { signal: context.signal })`),
  as `lookup-search-index` does for its measured search request.
- Leave `watchdogMs` unset to keep the legacy hang-until-`timeoutMs` behavior.

## Stream-Based Runners

`selection-clear`, `record-undo`, and `record-redo` drive `text/event-stream`
endpoints for their stream steps. When building or extending one, follow the
stream rules in [checklist.md](checklist.md): read to the final completion
event, assert business success, and keep setup streams out of the primary
metric. Use the perf SSE helper for raw stream calls so trace headers and
response trace refs are captured in artifacts.

`record-delete` uses the synchronous grid API `DELETE /selection/delete` with
the same `x-window-id` behavior as the UI. The delete setup for `record-undo`
and `record-redo` uses the same synchronous delete path; only the undo/redo
replay step is streamed.
