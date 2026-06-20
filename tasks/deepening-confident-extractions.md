# Deepening: confident extractions — handoff & caveats

Branch: `deepen/confident-extractions` (5 commits off `main`).
Source: 2026-06-21 `/improve-codebase-architecture` scan (9 slices → 40 findings
→ 32 rejected → 7 candidates). This branch implements the **5 zero-protected
candidates**. Each is its own commit so it can be reviewed, run, and reverted
independently.

These are framework-only refactors. They do not touch the protected surface
(case ids, `cases/**`, `registry.ts` contract, artifact JSON schema,
`framework/types.ts` config interfaces, thresholds/metrics/row counts, semantic
artifact fields, `../teable-ee`).

## Status at a glance

| #   | Commit    | Change                                                            | New module                      | Verification                                           |
| --- | --------- | ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| ③   | `25acaa3` | Lift `Measurement<T>` to `metrics.ts`; delete 8 dup defs          | (in `metrics.ts`)               | ✅ **pure type move — `pnpm check` is full proof**     |
| ①   | `59ccdbf` | `pollUntilReady` — 14 readiness poll loops delegate; `sleep` 11→1 | `framework/readiness.ts`        | ⚠️ **behaviour-touching — G1 required**                |
| ④   | `854eaac` | `forEachRecordPage` — 20 full-scan loops delegate                 | `framework/record-page-scan.ts` | ⚠️ **behaviour-touching — G1 required**                |
| ⑥   | `670eeb7` | `collectSampleRecords` + shared `SeededSampleRecord` (5 runners)  | `framework/sample-records.ts`   | ⚠️ **behaviour-touching — G1 required**                |
| ⑦   | `f3c5348` | Extract `chunk<T>`; delete 21 dup defs                            | `framework/chunk.ts`            | ✅ **pure function move — `pnpm check` is full proof** |

Whole branch: 46 files, net −377 lines, `pnpm check` green.

## ⚠️ Merge gate (read this first)

- **③ and ⑦ are pure type/function moves.** Behaviour is identical by
  construction; `pnpm check` (which runs the standalone type check) is sufficient
  proof. These can merge on green.
- **①, ④, ⑥ change runtime control flow.** Green source checks are **not**
  runtime acceptance (per `tasks/runner-framework.md`). They **must pass the G1
  artifact diff (v1+v2, baseline vs candidate) over their affected cases before
  merge.** Do not merge them on `pnpm check` alone.

### The one known behavioural delta (does not affect G1)

`pollUntilReady` (①) unifies the **on-timeout error message** at a few sites
(e.g. csv-import `"CSV import readiness timed out after …"` →
`"Timed out waiting for CSV import readiness after …"`; lookup-search-index gains
`" after <ms>ms"`). This text appears **only when a readiness wait times out**,
i.e. only on a failing run. It is never present in a passing-case artifact, so
the G1 diff (which compares passing artifacts) is unaffected. No code parses
these messages.

## How to run G1

Per `.agents/skills/localrun/SKILL.md`. In the injected `teable-ee` sandbox,
for each affected case id, run both engines on `main` (baseline) and on this
branch (candidate):

```bash
# baseline: on main; candidate: on this branch — same case, same engines
PERF_LAB_CASE_FILTER=<case-id> \
PERF_LAB_ENGINE_LIST=v1,v2 \
PERF_LAB_MODE=execute \
PERF_LAB_ARTIFACT_DIR=<out-dir> \
npx vitest run --config ./vitest-perf-lab.config.ts
```

Then compare each engine's artifact:

```bash
node scripts/diff-artifacts.mjs <baseline>/<case>-<engine>.json <candidate>/<case>-<engine>.json
```

Expected: `Artifact diff ok` for every affected case × engine. The comparator
masks run-to-run noise but keeps semantic fields (metric keys, threshold
metric/max/unit, phase names/order, `details.operation`, routing assertions,
`verifiedSamples.expected`, rowCount, batchSize) — so any real behaviour change
fails it.

See [Local G1 all-hits technique](../) note: for seedful runners make all runs
cache **hits** (warm seeds) or A=miss/B=hit produces an unmaskable
seedBuildMs-vs-seedRestoreMs asymmetry; the exception is runners emitting bare
fixture-table-id keys (e.g. link-computed `ordersTableId`) which must run
cache-**disabled**.

## Affected cases (what G1 must cover)

①, ④, and ⑥ collectively touch most read/mutation runners, so the practical move
is a **full v1+v2 baseline-vs-candidate G1 sweep**. Scoped per candidate:

- **① pollUntilReady** — runners migrated: conditional-lookup, field-create,
  field-update, record-read, formula-table, lookup-search-index,
  link-computed-propagation, field-convert, field-convert-link, csv-import.
  Cases: `lookup/conditional-10k`, all 4 `field-create/*`,
  `field-update/v2-only-10k-select-option-rename-computed-cascade` (v2 only),
  both `record-read/*`, both `formula/*`, both `search/*`, both
  `lookup/dual-link-computed-*`, `field-convert/10k-multi-select-to-text`,
  `field-convert/10k-text-to-formula`, `field-convert/10k-link-to-text`,
  `field-convert/10k-text-to-link`, all 3 `csv-import/*`.
- **④ forEachRecordPage** — runners migrated: form-submit, record-reorder,
  field-create, record-update-attachment, conditional-lookup, duplicate-table,
  record-paste, formula-table, field-update, import-base, record-update-link,
  duplicate-base, field-convert, field-convert-link, selection-clear,
  link-computed-propagation, record-duplicate.shared. Cases: the above plus
  `form-submit/sequential-200`, `record-reorder/10k-move-last-1k-to-front`,
  `record-update/attachment-insert-100`, both `duplicate-table/*`, all
  `record-paste/*` + `selection-paste/10k-expand-rows-and-fields-stream`,
  all 3 `import-base/*`, `record-update/1k-link-cells-bulk-update`, all
  `duplicate-base/*` + `export-base/*`,
  `selection-clear/flat-1k-20fields-cell-clear-stream`, both
  `record-duplicate/*`.
- **⑥ collectSampleRecords** — runners: conditional-lookup, field-update,
  field-convert, record-read, formula-table (subset of the above cases).

## Per-candidate caveats

### ① pollUntilReady (`framework/readiness.ts`)

- Helper is config-agnostic on purpose: callers pass plain `timeoutMs`,
  `pollIntervalMs`, `description`. field-create keeps reading `config.ready`
  (30s default), not `config.verify`; csv-import keeps its hard-coded timeout.
- field-create's `attempts` counter is preserved via the closure (incremented at
  the top of the assertFn thunk; pollUntilReady calls it once per poll).
- **5 loops deliberately LEFT inline** (not catch-and-retry readiness waits;
  cannot be expressed faithfully): csv-import `waitForCsvImportCompletion` and
  duplicate-table `waitForDuplicatedRows` (accumulate `attempts`/`waitedMs` the
  caller reads), and the status-pollers in import-base, duplicate-base,
  link-computed-propagation. `record-undo-redo.shared` `waitForRowsRestored`
  uses `< timeoutMs` (not `<=`) and was left.

### ④ forEachRecordPage (`framework/record-page-scan.ts`)

- Iterator owns the skip loop, `expectedTake = min(pageSize, total - skip)`, the
  per-page size guard, `rowNumber = skip + index + 1`, and scanned/page counts.
  Caller keeps fetch options, per-record body, final-count guard, return shape.
- `pageNoun` reproduces each original per-page error message exactly
  ("records", "pasted records", "orders", …). Count source preserved verbatim
  (`rowCount`/`recordCount`/`total`/`expected*`) — never normalised.
- **6 loops deliberately LEFT inline** (page-level / batch work onRecord can't
  express): record-read `assertProjectionFullScan` (batch `verifyRecords`) and
  `readPagedScan`, table-create's batch check, record-delete-link and
  record-duplicate.shared `assertRecordCount` (per-page count accumulation),
  selection-clear `restoreClearedCells`.

### ⑥ collectSampleRecords (`framework/sample-records.ts`)

- Only the seed-time **population** block was extracted (the byte-identical
  `forEach` that keys `{rowOffset, rowNumber, recordId}` by offset).
- The **retrieval** side (which offsets are required, the "missing sample"
  error, `recordCount` vs `rowCount` wording) is left per-runner — it diverges
  and that divergence is load-bearing (and `recordCount`/`rowCount` is a
  protected `types.ts` distinction).

### ③ Measurement (`framework/metrics.ts`)

- `measureAsync` now returns `Promise<Measurement<T>>` (same shape). csv-import
  keeps its own `CsvImportMeasurement` alias (a distinct lifecycle type).

### ⑦ chunk (`framework/chunk.ts`)

- Only the byte-identical `chunk<T>` was extracted. The `resolveFields`-style
  helpers (`resolveClearFields`, `resolveUpdateFields`, `resolveNamedField`) and
  the per-runner seed-batch loops were **deliberately not unified** — they
  diverge in return shape and cache semantics, so a shared version would be a
  leaky pass-through, not a deepening.

## Deliberately NOT done (do not re-propose without a dedicated task)

- **② Discriminated `PerfCase` union** — the highest-ceiling loud-on-error play
  (bind `runner` ↔ `config` at `tsc`, eliminate the 13 `as unknown as TConfig`
  casts). It **changes the protected surface** (`types.ts` config union +
  `definePerfCase` + registry dispatch contract), so it needs its own
  protected-surface task with the G1 proof the framework plan requires — not a
  drive-by edit.
- **⑤ case-catalog model + `check:catalog` (G4)** — low value: agents rarely
  touch the sync scripts, and most catalog drift is already caught loudly
  (`sync-perf-cases` throws on missing markdown; `check:readme` catches README
  drift). Only one narrow escape path (import-without-array-add) remains.

## How this branch was checked here

- Every commit: full `pnpm check` green (prettier + yaml + ts-syntax + the
  standalone **type check** + trace classification + case dry-run + readme).
- Each behaviour-touching migration was done as "keep the wrapper, delegate the
  mechanics": the named function keeps its signature and call sites; only the
  loop/body moves into the shared module. Non-conforming sites were identified
  and left inline (listed above), not forced.
- This is **not** a substitute for G1 on ①/④/⑥.
