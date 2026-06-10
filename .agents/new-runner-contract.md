# New Runner Contract

Use this only when no existing runner can express the case. The contract below
comes from the current runners; follow the same shapes before inventing new
ones.

## Required Wiring

A new runner needs these edits:

- `framework/types.ts`: add the runner kind, config interface, and include the
  config in `PerfCase["config"]`.
- `framework/runners/<runner>.runner.ts`: export `run<Runner>Case(perfCase,
context): Promise<PerfRunResult>`.
- `framework/run-perf-case.ts`: import the runner and add a switch branch.
- `registry.ts`: register concrete cases that use the new runner.
- `cases/<group>/<name>.case.ts` and `cases/<group>/<name>.md`: executable case
  and matching description.

Existing examples:

- Dispatch shape: `framework/run-perf-case.ts`.
- Simple runner: `framework/runners/http-endpoint.runner.ts`.
- Cache-aware computed runner: `framework/runners/formula-table.runner.ts`.
- Stateful mutation runner: `framework/runners/record-undo.runner.ts`,
  `framework/runners/record-redo.runner.ts`, and
  `framework/runners/record-undo-redo.shared.ts`.

## Result Shape

Return a `PerfRunResult` with:

- `metrics`: numeric values to report. Include setup diagnostics separately from
  the primary metric.
- `thresholds`: normally one threshold for the primary metric, using
  `getPrimaryThresholdMs(config.threshold.maxMs)`.
- `phases`: ordered phase durations from `measureAsync()`.
- `details`: ids, seed metadata, verification evidence, routing headers, trace
  refs, and compact error context.

Existing examples:

- `http-endpoint` returns repeated sample details and a `p95Ms` threshold.
- `formula-table` returns seed cache metadata, formula field ids, sample
  verification, and full-scan evidence.
- `record-undo-redo.shared.ts` centralizes mutation metrics, phases, seed cache
  details, setup timings, and final verification details.

## Failure Diagnostics

If setup or execute can partially complete, catch errors and throw
`PerfRunDiagnosticError` with the best partial `PerfRunResult` you can build.
This lets `framework/run-perf-case.ts` still write artifact JSON with completed
phase durations, ids, verification state, and the normalized error.

Existing examples:

- `record-delete.runner.ts`, `record-undo.runner.ts`, and
  `record-redo.runner.ts` catch inner operation failures and call
  `buildRecordReplayResult(...)`.
- `formula-table.runner.ts` catches source-ready and formula-ready failures and
  still reports created table/field ids and verification context.

## Trace Contract

For axios/OpenAPI calls, wrap important phases with:

```ts
withPerfTraceStep(context, perfCase, stepId, () => ...)
```

For raw `fetch` / SSE calls, use `perfStreamSse()` so the request carries perf
trace headers and the response `traceparent` is recorded.

Use stable `stepId` values that match the metric or phase name:

- Primary metric: `config.threshold.metric`.
- Setup: `deleteSetup1k`, `undoSetup1k`, `sourceReady`,
  `createLookupField`.
- Cleanup-only restore: a clear non-primary name such as
  `cleanupUndoRestore`.

Existing examples:

- `http-endpoint.runner.ts` wraps `warmup` and each sample.
- `formula-table.runner.ts` wraps seed creation, source readiness, field
  creation, and full scan readiness.
- `selection-clear.runner.ts` and `record-undo-redo.shared.ts` use raw SSE
  helpers for stream requests.

## Seed Cache Contract

If the runner has an expensive deterministic seed, use `buildSeedCacheInfo()`.
The seed hash should include:

- case id and runner kind
- seed-relevant config: row count, batch size, fields, generator,
  relationships, verification sample rows
- `fixtureVersion`
- seed builder code files and shared seed helpers

On a cache hit, still validate seed readiness before execute. On failure,
delete the stale fixture and rebuild.

After execute, cleanup must return reusable fixtures to seed-ready state or
delete them. Do not preserve a mutated seed table.

Existing examples:

- `formula-table.runner.ts`: source table is reusable; execute-created formula
  fields are removed in cleanup.
- `conditional-lookup.runner.ts`: source/host seed tables are reusable; lookup
  field is execute-only.
- `selection-clear.runner.ts`: cleared cells are restored to deterministic seed
  values.
- `record-undo-redo.shared.ts`: deleted rows are restored through the real undo
  path when the seed is reusable.
- `record-paste.runner.ts`: paste records are not cached because paste insertion
  is the measured workload.

## Verification Contract

Do not pass a case only because the request returned HTTP 200. Verify the final
state through the real read path.

Default to:

- sample verification for known rows or known values
- a paged full scan, usually `getRecords` with `take: 1000`

Use the final-state contract to choose the exact checks. Computed-field cases
must prove values. Delete cases must prove no visible records remain.
Restore/undo cases may use a paged row-count scan when the case only promises
row restoration; add sample value checks when the case promises value
restoration.

Existing examples:

- Formula and lookup cases verify sampled rows first, then full-scan computed
  values.
- Record mutation cases verify deleted/restored table state after each measured
  transition; current restore cases validate restored row count.
- Selection clear verifies cells are empty while rows remain present.

## Threshold Contract

Initial `maxMs` is a guardrail, not a benchmark result. Pick it from the closest
existing case and scale conservatively:

- Same runner and smaller/equal workload: start near the existing threshold.
- Same operation family but different scale: keep enough headroom for CI noise,
  then tighten after real V1/V2 runs.
- Unknown operation: choose a wide threshold so correctness and artifacts land
  first, then update once there is run history.

Always expose the primary threshold through `config.threshold.maxMs`; the
workflow can override it with `PERF_LAB_PRIMARY_THRESHOLD_MS` during
investigation.

Existing examples:

- HTTP endpoint uses `p95Ms` over repeated samples.
- Formula/lookup use readiness metrics such as `formulaFullReadyMs` and
  `conditionalLookupReadyMs`.
- Record mutation cases use operation-specific metrics such as `delete1kMs`,
  `undoReplay1kMs`, and `redoReplay1kMs`.

## Cleanup Contract

Always clean up in `finally`.

For non-cacheable fixtures, delete temporary tables. For cacheable fixtures,
preserve only if `seedReady` still passes after cleanup. If restore fails, delete
the fixture so a later run cannot reuse corrupted seed.

Existing examples:

- `record-delete.runner.ts` calls `cleanupRecordUndoRedoFixture(...)` in
  `finally`.
- Formula and lookup runners remove execute-created fields while keeping valid
  source seed tables.
- Paste runners delete their execute table because pasted records are the
  measured workload.
