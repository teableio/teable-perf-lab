# Runner Catalog & Decision

A runner is the reusable execution shape. The case config feeds it. Runner kinds
are defined in `framework/types.ts`; implementations live in
`framework/runners/*.runner.ts`.

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

| Runner                | Measures                                                                                | Use when                              |
| --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| `http-endpoint`       | repeated requests to one authenticated endpoint, p95                                    | simple GET latency, smoke timing      |
| `formula-table`       | create table + numeric rows, add formula field(s), wait until computed                  | formula / computed-field readiness    |
| `conditional-lookup`  | source + host tables, add conditional lookup, verify values                             | lookup / cross-table computed fields  |
| `lookup-search-index` | source + host lookup tables, search index on/off, repeated global search-index requests | lookup global search with table index |
| `field-create`        | empty table, create one field, verify field metadata                                    | field metadata creation               |
| `field-duplicate`     | source + host conditional lookup tables, create lookup setup, duplicate lookup field    | field metadata/data duplication       |
| `csv-import`          | empty table, upload CSV, import into existing table, verify records                     | CSV import into an existing table     |
| `record-paste`        | empty table, paste deterministic clipboard content via paste API                        | paste / bulk insert through selection |
| `record-create`       | empty mixed table, create typed records through OpenAPI                                 | direct bulk record create             |
| `record-update`       | seeded mixed table, update typed records through OpenAPI                                | direct bulk record update             |
| `record-reorder`      | seeded mixed table, move a visible record block through OpenAPI                         | manual row order mutation             |
| `selection-clear`     | seeded table, call selection clear stream, verify cells empty                           | clearing a large cell range           |
| `record-delete`       | mixed 1k table, delete all rows via selection delete                                    | row delete throughput                 |
| `record-undo`         | delete as setup, then measure undo-stream                                               | undo replay                           |
| `record-redo`         | delete + undo as setup, then measure redo-stream                                        | redo replay                           |

## Config Shapes

The exact interfaces are in `framework/types.ts`. Key fields per runner:

- **http-endpoint**: `method:"GET"`, `path`, `samples`, `threshold{metric:"p95Ms",maxMs}`, optional `validateSeedUser`.
- **formula-table**: `baseId:"seed-base"`, `tableNamePrefix`, `recordCount`, `batchSize`, `fields[]`, `generator{type:"numeric-sequence",titlePrefix}`, `formula` or `formulas[]`, `verify{sampleRows,...}`, `threshold{metric:"formula(s)(Full)ReadyMs",maxMs}`.
- **conditional-lookup**: source/host prefixes, `recordCount`, `batchSize`, `generator{type:"permuted-unique-key-sequence",...,permutation{multiplier,offset}}`, `lookup{name,limit}`, `verify`, `threshold{metric:"conditionalLookupReadyMs"}`. The `permutation` has a coprime constraint — see Deterministic Data in [checklist.md](checklist.md).
- **lookup-search-index**: source/host prefixes, `tableIndexMode:"off"|"on"`, `recordCount`, `batchSize`, `userCount`, `samples`, `generator{type:"lookup-search-index-20-fields",...,permutation{multiplier,offset}}`, `keywords[]`, `verify`, `threshold{metric:"lookupSearchIndexP95Ms"}`. Seed creates lookup fields and turns table search index on only for the ON host; execute measures repeated `aggregation/search-index` requests for the selected mode only.
- **field-create**: `tableNamePrefix`, `baseFields[]`, `field`, `verify{optionCount,sampleOptionIndexes}`, `threshold{metric:"singleSelectCreateOptionsMs"}`. Seed creates an empty base table; execute creates the configured field and verifies field metadata.
- **field-duplicate**: `sourceTableNamePrefix`, `hostTableNamePrefix`, `recordCount`, `batchSize`, `generator{type:"permuted-unique-key-sequence",...,permutation{multiplier,offset}}`, `lookup{name,limit}`, `duplicate{name}`, `verify`, `threshold{metric:"conditionalLookupDuplicateReadyMs"}`. Seed reuses the conditional lookup 10k table shape; execute creates the source lookup field as setup, duplicates it, then verifies the duplicated lookup values.
- **csv-import**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-csv-import",titlePrefix,payloadPrefix,valuePrefix}`, `verify`, `threshold{metric:"csvInplaceImportReadyMs"}`.
- **record-paste**: `tableNamePrefix`, `rowCount`, optional `maxPasteCells`, `fields[]`, `generator{type:"flat-copy-paste"|"mixed-copy-paste",titlePrefix,...}`, `verify`, `threshold{metric:"paste10kMs"}`.
- **record-create**: `tableNamePrefix`, `rowCount`, `fields[]`, `generator{type:"mixed-record-create",titlePrefix,payloadPrefix,valuePrefix}`, `verify`, `threshold{metric:"bulkCreate1kMs"}`. The reusable seed is the empty mixed table plus cached typed create payload; execute creates records fresh.
- **record-update**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-record-update",seedPrefix,updatePrefix}`, `verify`, `threshold{metric:"bulkUpdate1kMs"}`. The reusable seed stores deterministic records and cached record ids; non-isolated cleanup restores seed values.
- **record-reorder**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-undo-redo",...}`, `reorder{blockStartOffset,blockSize,anchorOffset,position}`, `verify`, `threshold{metric:"moveLast1kToFrontMs"}`. The reusable seed stores initial order metadata; non-isolated cleanup restores the original order.
- **selection-clear**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"flat-table-operation",titlePrefix,payloadPrefix}`, `verify`, `threshold{metric:"clear1kMs"}`.
- **record-delete / record-undo / record-redo**: share `RecordUndoRedoBaseCaseConfig` (`tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-undo-redo",...}`, `verify`). They differ only in the threshold metric: `delete1kMs` / `undoReplay1kMs` / `redoReplay1kMs`. The shared mixed-record base config is exported as `undoRedo10kBaseConfig` in `framework/runners/record-undo-redo.shared.ts` — spread it and override `rowCount`, `tableNamePrefix`, `verify`, and `threshold` for the 1k cases.

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
