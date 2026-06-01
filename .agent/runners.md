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
3. **New runner** only when extending would distort an existing runner. A new
   runner needs: a kind in `framework/types.ts`, a config interface there,
   dispatch in `framework/run-perf-case.ts`, and
   `framework/runners/<kind>.runner.ts`.

## Catalog

| Runner               | Measures                                                               | Use when                              |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `http-endpoint`      | repeated requests to one authenticated endpoint, p95                   | simple GET latency, smoke timing      |
| `formula-table`      | create table + numeric rows, add formula field(s), wait until computed | formula / computed-field readiness    |
| `conditional-lookup` | source + host tables, add conditional lookup, verify values            | lookup / cross-table computed fields  |
| `record-paste`       | empty table, paste deterministic clipboard content via paste API       | paste / bulk insert through selection |
| `selection-clear`    | seeded table, call selection clear stream, verify cells empty          | clearing a large cell range           |
| `record-delete`      | mixed table, delete all rows via delete-stream                         | row delete throughput                 |
| `record-undo`        | delete as setup, then measure undo-stream                              | undo replay                           |
| `record-redo`        | delete + undo as setup, then measure redo-stream                       | redo replay                           |

## Config Shapes

The exact interfaces are in `framework/types.ts`. Key fields per runner:

- **http-endpoint**: `method:"GET"`, `path`, `samples`, `threshold{metric:"p95Ms",maxMs}`, optional `validateSeedUser`.
- **formula-table**: `baseId:"seed-base"`, `tableNamePrefix`, `recordCount`, `batchSize`, `fields[]`, `generator{type:"numeric-sequence",titlePrefix}`, `formula` or `formulas[]`, `verify{sampleRows,...}`, `threshold{metric:"formula(s)(Full)ReadyMs",maxMs}`.
- **conditional-lookup**: source/host prefixes, `recordCount`, `batchSize`, `generator{type:"permuted-unique-key-sequence",...,permutation{multiplier,offset}}`, `lookup{name,limit}`, `verify`, `threshold{metric:"conditionalLookupReadyMs"}`. The `permutation` has a coprime constraint — see Deterministic Data in [checklist.md](checklist.md).
- **record-paste**: `tableNamePrefix`, `rowCount`, optional `maxPasteCells`, `fields[]`, `generator{type:"flat-copy-paste"|"mixed-copy-paste",titlePrefix,...}`, `verify`, `threshold{metric:"paste10kMs"}`.
- **selection-clear**: `tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"flat-table-operation",titlePrefix,payloadPrefix}`, `verify`, `threshold{metric:"clear1kMs"}`.
- **record-delete / record-undo / record-redo**: share `RecordUndoRedoBaseCaseConfig` (`tableNamePrefix`, `rowCount`, `batchSize`, `fields[]`, `generator{type:"mixed-undo-redo",...}`, `verify`). They differ by operation and threshold metric, for example `delete1kMs`, `undoReplay10kMs`, or `redoReplay1kMs`. The shared 10k base config is exported as `undoRedo10kBaseConfig` in `framework/runners/record-undo-redo.shared.ts` — spread it and override `rowCount`, `tableNamePrefix`, `verify.sampleRows`, and `threshold` when a case uses a smaller workload.

## Stream-Based Runners

`selection-clear`, `record-delete`, `record-undo`, `record-redo` drive
`text/event-stream` endpoints. When building or extending one, follow the stream
rules in [checklist.md](checklist.md): read to the final completion event,
assert business success, and keep setup streams out of the primary metric.
