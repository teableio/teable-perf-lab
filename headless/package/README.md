# Headless performance harness

`@teable/v2-headless-bench` runs reproducible Teable v2 core workloads against PGlite or PostgreSQL. A `.tea` archive provides schema and optional CSV data; a `case.manifest.json` defines deterministic data, operations, correctness oracles, and budgets. Reports distinguish write acknowledgement from computed drain. They measure headless core/database behavior, **not** Nest/HTTP throughput or deployment capacity. PGlite is a semantic, single-writer backend; its timings are not PostgreSQL latency SLO evidence.

This package is maintained in `teable-perf-lab/headless/package`, not the product repository.
First mount it into an independently pinned Teable source checkout using the
[cross-repository setup](../README.md). Run the commands below from that prepared source
workspace. The mount preserves workspace package imports and fixture paths without copying
Core implementation into perf-lab; CI receipts record both source and harness revisions.

## Commands

The CLI is a Node program built from `src/cli.ts` to `dist/cli.js` (`pnpm --filter @teable/v2-headless-bench bench -- --help`). Workspace dependencies must be built first; the build also copies PGlite WASM assets beside the CLI. There is no installed CLI binary.

Commands that write reports require an explicit output path. `run` and `compare` never choose a repository-relative report location; the examples below keep generated output under `/tmp`.

```sh
pnpm --filter @teable/v2-headless-bench bench -- generate \
  --spec community/packages/v2/headless-bench/fixtures/smoke.generator.json \
  --out /tmp/bench-cases

pnpm --filter @teable/v2-headless-bench bench -- run \
  --case /tmp/bench-cases/<caseId>/case.manifest.json \
  --backend pglite --samples 3 --warmup 1 \
  --out /tmp/bench-run.json --evidence /tmp/bench-evidence.json

pnpm --filter @teable/v2-headless-bench bench -- report render \
  --input /tmp/bench-evidence.json --out /tmp/bench-evidence.zh.md
pnpm --filter @teable/v2-headless-bench bench -- report render-html \
  --input /tmp/bench-evidence.json --out /tmp/bench-evidence.zh.html
pnpm --filter @teable/v2-headless-bench bench -- report export-teable \
  --input /tmp/bench-evidence.json --out /tmp/bench-evidence.rows.json

pnpm --filter @teable/v2-headless-bench bench -- compare \
  --baseline /tmp/baseline.json --candidate /tmp/bench-run.json \
  --out /tmp/bench-compare.json

pnpm --filter @teable/v2-headless-bench bench -- verify --run /tmp/bench-run.json
```

## CI performance gate

`@teable/v2-headless-bench` replaces the former Vitest `benchmark-node` job. CI runs
`pnpm -r --filter @teable/v2-headless-bench... build` followed by
`pnpm --filter @teable/v2-headless-bench bench:ci`. This builds only the benchmark dependency closure,
then runs one deterministic bounded case per registered rule, grouped into parallel behavior-family
jobs against PostgreSQL. The default catalogue is unchanged; its profile variants and full-size opt-in
cases are not claimed as executed by the PR gate. Four extreme rules use separately identified PR-size
variants that preserve the behavior but do not establish full-scale performance.

Deterministic rollup, lookup, conditional-link, formula and selected propagation fixtures opt into
`identical-state` full-recompute references. For each
checkpoint and repetition the first successful sample builds a fresh full-recompute reference;
subsequent fresh samples still compare exact typed source values and ordered links plus every
selected computed value against it. Computed comparisons retain the existing normalization
tolerance. Changed inputs, mismatched results, missing identity mappings and failed references do
not pass or establish a new reference. Other fixtures retain full recomputation per invocation.
Benchmark builds disable TypeScript declaration generation; they still build the runtime closure.

The suite runs its case families in parallel within one CI and publishes a single final report table.
Each row distinguishes a fixed-budget whole workload from a score-model operation; only the latter
has a complexity score and predicted p95. The report explains the columns and demonstrates one
measured row. Calibration remains separate and pinned so a gate cannot calibrate itself. Raw JSON
and samples remain in private evidence artifacts, not expanded in the human-readable report.

Native workflow reruns keep the same private evidence channel so a partial failed-job rerun can reuse successful sibling-family archives. The consolidator always receives the current effective runtime and benchmark-matrix results; any non-success status adds an execution row and forces the overall report to FAIL even when retained family summaries pass. Consolidated Markdown uses a run-attempt-specific asset name, and both check summaries and private reports request that exact asset; a failed rerun therefore cannot display an earlier attempt's PASS. Retained family rows remain visible as prior-attempt evidence rather than current execution evidence.
The current fixed and complexity budgets are provisional guardrails, not customer SLOs or verified
baseline-versus-candidate regression results. A separate paired comparison requires independently
collected process blocks, matching workload/environment identities, a declared practical threshold,
and characterized noise. If those inputs or a comparable baseline are unavailable, the report
states `inconclusive / not measured`; it must not imply the paired regression passed. Product SLOs
require a separately declared metric, threshold, and source; none is inferred from benchmark history.

The separate `headless-http` job starts `@teable/v2-headless-http` on `127.0.0.1` and times real
TCP HTTP requests through the V2 router against PostgreSQL. It exercises base creation/listing;
table, field, and record CRUD; batch writes; filtering/pagination; CSV append and new-table import;
and computed drain. Each operation validates its HTTP status and envelope; untimed reads verify the
persisted result. `budgets/http.budgets.json` is calibrated independently from the core catalogue.
This is not a Nest application benchmark and does not test its authentication, permissions, audit,
or production deployment capacity. Base update/delete are not exposed by the headless V2 contract.

The `core-operations` job measures Core command/query buses directly: base create/list; table
create/list/rename/delete; field create/list/rename/convert-on-populated-data/delete; streaming
record creation, paste, clear, upsert, delete-by-range, filter/sort/search/aggregate; CSV and XLSX
imports. Each operation is timed separately and its persisted state is checked independently.
`core-scale` seeds 10,000 source rows plus 1,000 fanout rows and validates source → formula → link →
lookup → formula → rollup → conditional lookup/rollup propagation after a single-record mutation.
The larger 100,000-row / 10,000-fanout profile is opt-in and not claimed by the CI gate.
`core-extra` exercises single-record create/get/duplicate, multi-table creation, table properties,
table duplication and bulk field create/delete/duplicate with and without copied record values.
`core-transitions` checks linked record create/delete and conditional-rollup enter/leave transitions,
including the final empty state. `core-views` measures view create/list/get/rename/duplicate/delete,
description/filter/sort/group/column-metadata updates and view-scoped reads on populated records.
`core-computed-changes` measures computed field creation on populated data, formula expression
updates, linked-source updates and unlink/relink, each verified after a separately timed drain.
`core-query-cases` covers empty/selective filters, full cursor traversal, grouped and search metadata,
count, grouped aggregation and saved-view defaults. Each uses a fresh owned base per round.
`core-relation-cases` covers bidirectional one-to-one and one-to-many lifecycle and linked target
deletion; `core-field-transitions` checks mixed valid/invalid/null text conversions and dependent
formulas. `core-volume-cases` creates and queries/updates/deletes a real 10,000-row table;
`core-fanout-deletion` deletes a linked source with 1,000 dependents and validates every target.
Explicit `core-volume-large`, `core-fanout-large`, and `core-scale-large` selections use real
100,000-row or 10,000-fanout profiles, but are opt-in and not evidence of CI execution.
New tracks require measured PostgreSQL budgets; uncalibrated tracks are not performance passes.
Undo, redo, and realtime are explicitly excluded from these tracks.

The checked-in `budgets/catalogue.budgets.json` supplies a `tea-bench-budget/1` policy per exact
`scenarioId`:

- `maxP95Ms` for the complete ordered workload;
- one `maxP95Ms` for every measured operation, so a fast operation cannot hide a slow one;
- optional positive operation weights used only for the displayed score.

The score is `100 × budget / observed p95`. The case score is a weighted geometric mean of operation
scores; the suite score is the geometric mean of case scores. Scores rank headroom only: CI still fails
when any correctness oracle fails, any operation exceeds its own budget, or the whole workload exceeds
its case budget. A score from another runner is not comparable.

Operation budgets carry a declared 5 ms timing floor: sub-millisecond p95 values are dominated by timer
and scheduler noise, so those operations are gated at the floor and their measured value is still
reported. A regression inside that floor is therefore not a gate failure.

p95 needs at least 20 samples. Catalogue cases use a fresh disposable runtime for every warmup pass
and measured sample. A warmup executes the complete ordered workload, checkpoints and final oracle;
its timings, receipts and full-recompute references never enter measured evidence. `core-scale` reuses
one seeded runtime, restoring and validating the same baseline outside each timed sample. These
repeated samples are not independent fresh-runtime observations. Fewer than 20 samples are
`inconclusive`, never a pass. CI uses 100 samples so p95 resolves a five-observation tail rather than
the second-largest of 20, while every raw sample remains in private evidence. CI uses a fixed PostgreSQL
service and stores `summary.json` plus every raw run receipt. Budgets are made from observed p95 values
multiplied by explicit headroom; schema
scores never pretend to predict time. Fixed-budget and complexity artifacts bind their warmup strategy,
timing scope, statistic, sample count and repetition count; a mismatch requires recalibration and fails
closed. Set `TEABLE_BENCH_CALIBRATE=<headroom>` and
`TEABLE_BENCH_CALIBRATE_SOURCE=<runner description>` to rewrite the budget file from one complete
measured catalogue pass. Recalibrate on the same runner before tightening a budget; changing a fixture,
workload, measurement protocol, runner, PostgreSQL version, or budget model starts a new calibration
series. Core catalogue budgets bind the executable `caseId` (schema, dataset, workload and oracle
hash); changing a template requires measured recalibration even if the rule ID is unchanged.

The separate `bench:complexity-ci` correlates the existing versioned 0–100 complexity ranking
score with measured p95 **within a single operation family and tested fixture shape**. It calibrates
formula depth, formula width, and linked fanout separately using two distinct score points and a
third, independently measured holdout. The series declare an assumption that every dirty computed
output changes; it is a conservative planning input, not an observed change rate. The report
preserves that assumption and the score components. Interpolated expected p95 and its 3× operational
headroom are empirical, not a confidence interval or production latency SLO.

Gate runs use a separately pinned calibration artifact; score gaps, tied points, missing assumptions,
fixture or measurement-protocol drift, runner changes and extrapolation are inconclusive, never a pass.
A 20-sample p95 resolves its order-statistic rank but does not provide a precise statistical confidence
interval.
For methodology see [NIST on percentile estimation](https://www.itl.nist.gov/div898/handbook/prc/section2/prc262.htm),
[NIST on model validation](https://www.itl.nist.gov/div898/handbook/pmd/section4/pmd44.htm) and
[Google Benchmark on variance](https://google.github.io/benchmark/reducing_variance.html).
These series do not cover every Core operation; other tracks still use exact-case measured budgets.

Environment overrides for local smoke work:

- `PRISMA_DATABASE_URL` (required);
- `TEABLE_BENCH_OUT_DIR` (default `/tmp/teable-headless-bench`);
- `TEABLE_BENCH_SAMPLES` (CI uses 100);
- `TEABLE_BENCH_MAX_CASES` (local/debug only; CI leaves it unset and runs every selected rule).
- `TEABLE_BENCH_FAMILIES=<family[,family]>` restricts a leg to those behavior families; CI runs one leg per family in parallel.
- `TEABLE_BENCH_BUDGETS` (default `budgets/catalogue.budgets.json` beside the built CI entry);
- `TEABLE_BENCH_CALIBRATE=<headroom>` with `TEABLE_BENCH_CALIBRATE_SOURCE=<runner>` rewrites that file from one complete measured pass; calibration emits `not-compared` runs and is not itself a passing gate.

- `generate --spec <path> --out <dir>` generates pairwise cases. The output override replaces the spec's `outDir`. Success prints `{ "ok": true, "data": { "cases": [], "coverage": {} } }` with the actual cases and coverage.
- `run --case <manifest> [--tea <path>] [--backend pglite|postgres] [--connection <url>] [--samples <n>] [--warmup <n>] [--repetitions <n>] --out <path> [--evidence <path>] [--evidence-input <plan.json>]` writes a low-level run report to the explicit output path and optionally canonical evidence JSON. With `--evidence`, commit/dirty state, host, runtime/backend versions, actual manifest/archive hashes and actual receipts are captured at invocation; no factual JSON input is required. Optional `--evidence-input` supplies only catalogue scope and planned suite receipts and cannot override captured provenance or claim a performance pass. Both the manifest's `source.tea` and an explicit `--tea` are resolved relative to the manifest directory; PostgreSQL requires `--connection` or `TEABLE_BENCH_CONNECTION`.
- `compare --baseline <run.json> --candidate <run.json> --out <path>` writes descriptive p95 ratios to the explicit output path. Independent invocations have no verified paired experiment identity, so it emits no confidence interval, has no regression threshold, and leaves the comparison inconclusive. A declared candidate p95 SLO remains a separate standalone decision.
- `verify --run <run.json>` reads an existing report and prints `{ "ok": true, "data": { "runId": "…", "caseId": "…", "oracleStatus": "pass", "verdict": "pass" } }`. It summarizes recorded results; it does not rerun workloads or oracles.

Generate exits 0 on success. Run and compare exit 0 for `pass` or `inconclusive`, 1 for `fail`. Verify exits 0 only for `pass`, and 1 for `fail` or `inconclusive`. Every command exits 1 on an error and prints one JSON error envelope to stderr:

```json
{ "ok": false, "error": { "code": "bench.cli.argument_invalid", "message": "…", "details": {} } }
```

`details` is omitted when unavailable. Unknown commands use `bench.cli.command_unknown`; unknown flags, unexpected positional arguments, missing required flags, and invalid numeric/backend values use `bench.cli.argument_invalid`. Unreadable or malformed JSON uses `bench.cli.json_invalid`; other non-domain failures use `bench.cli.unexpected`. Paths you pass are resolved from the directory you invoked the command in, and output parent directories must already exist.

## Reference business operations case

`fixtures/reference-business-operations.generator.json` defines one bounded representative business-operations workflow, not an exhaustive Teable compatibility suite. Its reproducible synthetic `.tea` archive and generated manifest are checked in at:

- `community/packages/v2/headless-bench/fixtures/reference-business-operations/fixture.tea`
- `community/packages/v2/headless-bench/fixtures/reference-business-operations/case.manifest.json`

The archive contains a real four-table schema; `source.dataMode=recipe` generates the records deterministically after import. It is a reproducible synthetic sample, **not customer data**. Accounts represent customer or internal business units; each Account owns Projects; Work Items are executable tasks within a Project; Time Entries record actual hours spent on a Work Item. Initial counts are Accounts 20, Projects 80, Work Items 400, Time Entries 1,200. The workload creates two work items and deletes one time entry as its last write, leaving 20 / 80 / 402 / 1,199 records. The generator's optional template `rowCounts` fixes these per-table business proportions; other templates retain the existing root-table / one-tenth scaling rule. Dataset and case hashes are generated, never hand-authored.

The case exercises basic text/long-text/number/date/checkbox/select/rating storage, record create/update/delete, core filter/sort/projection reads, structured query aliases, formulas, one-way many-one and many-many links, lookup/rollup values, explicit computed drains, link clear/restore, checkbox null-clear/restore, an invalid strict numeric update with unchanged-state proof, final invariants and full-recompute consistency. Literal checks verify budget reserve 1,000, time-entry cost 200, planned effort 16→20 and link rollup 6→0→6. One-way links are intentional: Work Items → Time Entries membership and Time Entries → Work Item are separate directed relationships, not an implied symmetric reverse link. Final link-count checks verify the Time Entries → Work Item links survive seeding and mutation.

This case does **not** cover every field type, arbitrary formula programs, all query operators, schema changes, two-way link behavior, permissions/authentication, user-directory resolution, attachments, UI, HTTP, concurrent writers or production capacity. Full recompute copies at most 5,000 rows (actual fixture scale below 1,703), under the default 10,000-row cap, and shares the Teable calculation engine; it is a consistency check rather than an independent formula implementation.

Run from the workspace root. The following commands write fresh evidence only to `/tmp/reference-business-operations`, outside tracked source paths. Keep these observed receipts and derived reports private. Output parent directories must exist:

```sh
mkdir -p /tmp/reference-business-operations
pnpm --filter @teable/v2-headless-bench bench -- run \
  --case community/packages/v2/headless-bench/fixtures/reference-business-operations/case.manifest.json \
  --backend pglite --samples 1 --warmup 0 \
  --out /tmp/reference-business-operations/run.json \
  --evidence /tmp/reference-business-operations/report.json
pnpm --filter @teable/v2-headless-bench bench -- report render-html \
  --input /tmp/reference-business-operations/report.json \
  --out /tmp/reference-business-operations/report.zh.html
pnpm --filter @teable/v2-headless-bench bench -- report render \
  --input /tmp/reference-business-operations/report.json \
  --out /tmp/reference-business-operations/report.zh.md
pnpm --filter @teable/v2-headless-bench bench -- report export-teable \
  --input /tmp/reference-business-operations/report.json \
  --out /tmp/reference-business-operations/report.rows.json
```

After these exact commands, open `/tmp/reference-business-operations/report.zh.html` in a browser, or read `/tmp/reference-business-operations/report.zh.md`. Canonical evidence is `/tmp/reference-business-operations/report.json`; the low-level runner receipt is `/tmp/reference-business-operations/run.json`; the five normalized Teable row groups are in `/tmp/reference-business-operations/report.rows.json`. These are fresh observations on your current host, not checked-in performance claims. A single PGlite sample proves the bounded workflow can run and its checks can pass; it cannot produce a performance pass.

To regenerate the archive and manifest without hand-editing hashes:

```sh
pnpm --filter @teable/v2-headless-bench bench -- generate \
  --spec community/packages/v2/headless-bench/fixtures/reference-business-operations.generator.json \
  --out /tmp/reference-business-operations-generated
```

Generation prints the exact `teaPath` and `manifestPath`. Its normal output is `/tmp/reference-business-operations-generated/<caseId>/pglite/{fixture.tea,case.manifest.json}`; copy those two files together to the stable fixture directory only when deliberately updating the checked-in case. The targeted end-to-end test is `pnpm --filter @teable/v2-headless-bench exec vitest run src/e2e/referenceBusinessOperations.spec.ts`.

### Per-operation explanations and impact evidence

Add `--impact <path>` to `run` together with `--evidence` to write a deterministic `tea-bench-impact-graph/1` sidecar. It preserves the canonical `tea-bench-report/2` schema and uses the same stable per-execution `operationId` keys. The CLI also writes `<path>.rows.json` with normalized operation/node/edge rows and machine-readable explanation JSON. No model or AI service is called: expectations are authored in the manifest and pass/fail comes from runner code comparing expected and actual values.

```sh
mkdir -p /tmp/reference-business-operations-flow
pnpm --filter @teable/v2-headless-bench bench -- run \
  --case community/packages/v2/headless-bench/fixtures/reference-business-operations/case.manifest.json \
  --backend pglite --samples 1 --warmup 0 \
  --out /tmp/reference-business-operations-flow/run.json \
  --evidence /tmp/reference-business-operations-flow/report.json \
  --impact /tmp/reference-business-operations-flow/impact.json
pnpm --filter @teable/v2-headless-bench bench -- report render-html \
  --input /tmp/reference-business-operations-flow/report.json \
  --impact /tmp/reference-business-operations-flow/impact.json \
  --out /tmp/reference-business-operations-flow/report.zh.html
```

Open `/tmp/reference-business-operations-flow/report.zh.html`. The first screen states what the run does, correctness/execution/performance verdicts, declared initial table counts, and what the run does not claim. The business flow is derived from hash-verified `.tea` link declarations in canonical provenance: Accounts → Projects → Work Items → Time Entries. If that archive is unavailable or does not match its recorded hash, the renderer omits topology rather than guessing. A semantic lifecycle strip and Chinese text-list fallback explain prepare → query/create/update/delete → computed drain → expected-versus-actual check → report. Declared, observed, estimated and unknown evidence have a compact legend.

Correctness comes before performance. All 33 manifest steps remain in order, grouped into five business phases, with concise purpose/target/expected/status summaries. Native keyboard-friendly `<details>` sections retain raw keys/check IDs, full expected/actual evidence, relationship tables and optional SVGs, per-operation timing samples, provenance, and canonical raw JSON. These are presentation-only changes: no AI judgment, altered pass/fail rules, or report/2 and impact sidecar evidence changes. Exact outputs are `/tmp/reference-business-operations-flow/{run.json,report.json,impact.json,impact.json.rows.json,report.zh.html}`. One PGlite sample does not support a performance pass.

Evidence is typed: **declared** = manifest/schema intent, **estimated** = `run.json` complexity assessment paths, **observed** = runner return/command-target IDs or processed task count, **unknown** = unobserved affected tables/rows/cells. IDs are bounded to 100 per operation, nodes to 160, edges to 240; sidecars contain no cell values. Observed IDs mean returned or selected/created command targets, never confirmed changed computed cells. Structured query rows may expose aliases but no record IDs. Flush `processed` counts tasks, not records. Counts sum across successful samples and must not be confused with deduplicated retained IDs or affected rows. No outbox/raw-database tracing is used. Checkpoints validate the state after an explicit operation sequence; a check after a flush is not causal proof of the flush alone. Expected errors remain correctness steps, not fake measured operations.

## Scenario coverage

Coverage is defined by the versioned rule registry, supplied schema, resource bounds, and assertion receipts. It does not claim every conceivable Teable behavior. The Chinese catalogue says what each rule changes, which boundary it reaches, which oracle proves it, and which host/concurrency/formula-program behaviors remain excluded.

For factor domains $D_1…D_d$, each compatible rule gets its own bounded pairwise covering array with exact count $\sum_{i<j}|D_i||D_j|$. Factors physically change the generated fixture recipe. Constraints remove a pair only after bounded search proves it has no valid completion; a search limit produces an explicit unknown/truncated gap. Rare, boundary, three-way, and extreme rules are forced scenarios emitted before pairwise scenarios, so a case cap cannot silently discard them. Reports distinguish pairs included in the plan from pairs actually executed and verified by assertions.

The registry currently has 31 rules and all have concrete materializers. The default bounded catalogue emits 82 scenarios: 28 forced/base scenarios plus 18 profiles for each of the three pairwise-compatible rules. Full-size depth-32, width-128, high-fanout and million-row scenarios remain opt-in; catalogue presence is not an execution claim.

`deriveCases` maps an arbitrary `.tea` graph with bounded reachability, without enumerating dependency paths. It records exact source-table/source-field → mutation → target-field/edge obligations. One source mutation may check several impacted targets with a full-recompute oracle, but every target/edge retains its own obligation ID and remains unverified until a passing per-check execution receipt references it. Similar depth/type buckets are performance sampling hints, not field coverage.

Customer data modes are distinct. `recipe` (default) preserves the schema and replaces record contents with deterministic synthetic data. `materialized` preserves optional original CSV bytes for final-data replay; it can contain private data, may hit row/resource caps, and record IDs/link references constrain portability. It is never silently selected.

The pipeline is: **读取表结构 → 识别计算关系 → 选择操作 → 生成数据档位 → 校验 → 生成清单**. Requested rules, applicable obligations, planned mappings, actual executions, and passing assertions are separate counts. Legitimately nullable outputs use exact-value or full-recompute checks; derivation does not impose automatic non-null or primary-uniqueness requirements on customer schemas.

```sh
pnpm --filter @teable/v2-headless-bench bench -- catalogue enumerate \
  --out /tmp/headless-catalogue.json --markdown /tmp/headless-catalogue.zh.md \
  --max-cases 100 --max-search-states 100000 --max-millis 5000
```

`--max-cases`, `--max-search-states`, and `--max-millis` must be positive integers. Search bounds apply to pairwise factor classification; the factor domains are the fixed three nuisance dimensions, so candidate construction itself stays linear in rule count. When `--max-cases` omits candidates, the receipt keeps `applicable` from all candidates and lists the omitted rule/scenario IDs in `gaps` instead of reclassifying them as inapplicable.

Materialize one exact scenario (do not select by title or index), inspect its manifest, then run a correctness smoke with three measured samples (performance remains inconclusive):

```sh
pnpm --filter @teable/v2-headless-bench bench -- catalogue materialize \
  --scenario <exact-scenarioId> --out /tmp/headless-case
pnpm --filter @teable/v2-headless-bench bench -- run \
  --case /tmp/headless-case/<scenarioId>/case.manifest.json \
  --samples 3 --warmup 1 --out /tmp/headless-case/run.json \
  --evidence /tmp/headless-case/report.json
pnpm --filter @teable/v2-headless-bench bench -- report render \
  --input /tmp/headless-case/report.json --out /tmp/headless-case/report.zh.md
pnpm --filter @teable/v2-headless-bench bench -- report export-teable \
  --input /tmp/headless-case/report.json --out /tmp/headless-case/report.rows.json
```

`src/report/fixtures/observedSmoke.ts` is a runnable PGlite smoke tool, not a checked-in execution example. It requires an explicit, existing private output directory outside the checkout (symlink destinations are checked too):

```sh
mkdir -p "$HOME/private-headless-results"
pnpm --filter @teable/v2-headless-bench exec bun --conditions=@teable/source \
  src/report/fixtures/observedSmoke.ts \
  --out-dir "$HOME/private-headless-results"
```

The tool writes `observed-smoke.{run.json,scenario.json,report.json,md,rows.json}` there. These real receipts include source provenance, execution timestamps, environment details and raw samples; keep them and all derived exports private. No observed receipts are shipped with this package. `deterministic-*` fixtures remain explicitly format-only test data; reference-business `.tea` fixtures remain synthetic business data, not observed execution evidence.

To add executable behavior, implement a real template/workload/oracle materializer first, then add the registry rule and forced transitions. Clear→restore, false→true→false, and 0→1→many→remove-last each require an assertion after every state, not only after final recovery.

To add a motif:

1. Add a template with a unique `id`, a declared `rootTable`, and valid raw DotTea `structure`: table IDs are `tbl` plus 16 alphanumerics, field IDs are globally unique `fld` plus 16 alphanumerics, links use `options`, lookups/rollups use `lookupOptions`, and formula expressions refer to declared field IDs. Declare both symmetric link fields when testing a two-way relation.
2. Add its `dataset` recipe, source-table write workload, computed drain, and dependent-table query. Put the write on the table that actually invalidates the dependency. For a predicate update, exercise both membership transitions.
3. Add row-count/computed invariants and a full-recompute consistency check. The generator rewrites final row counts for one complete workload on a fresh sample; changing CLI sample count does not multiply creates/deletes within that state. Add a before/after E2E assertion for the dependency being introduced.
4. Add the template ID to `dimensions.motif`, add any required `forcedRows`, generate, and inspect the coverage report. Extend the generator test's expected pair/case totals and run the new motif on PGlite. Only the supported dimensions (`motif`, `rows`, `typecast`, `batchSize`, `backend`) may be declared; a new dimension requires generator support.

```sh
pnpm --filter @teable/v2-headless-bench bench -- generate \
  --spec community/packages/v2/headless-bench/fixtures/catalog.generator.json \
  --out /tmp/catalog-cases
pnpm --filter @teable/v2-headless-bench exec vitest run src/generator/generate.spec.ts
pnpm --filter @teable/v2-headless-bench bench -- run \
  --case /tmp/catalog-cases/<caseId>/pglite/case.manifest.json \
  --backend pglite --samples 3 --warmup 1 --out /tmp/catalog-run.json
jq '{verdict, oracle: .oracle.status}' /tmp/catalog-run.json
```

## Manifest contract

```json
{
  "caseId": "sha256:<64 lowercase hexadecimal characters>",
  "specVersion": 1,
  "generatorVersion": "tea-bench/1",
  "title": "Orders update and computed drain",
  "dimensions": { "motif": "formula-lookup-formula", "rows": 100 },
  "source": { "tea": "fixture.tea", "dataMode": "recipe" },
  "dataset": {
    "rows": { "Customers": 10, "Orders": 100 },
    "seed": { "schema": 7, "data": 7, "query": 7, "schedule": 7 },
    "recipe": {
      "tables": {
        "Customers": { "fields": {} },
        "Orders": {
          "fields": {
            "Amount": { "min": 1, "max": 1000 },
            "Customer": { "link": { "table": "Customers", "relationship": "manyOne" } }
          }
        }
      }
    }
  },
  "run": {
    "backend": "pglite",
    "samples": 5,
    "warmup": 2,
    "repetitions": 1,
    "seedBatchSize": 1000,
    "actorId": "usr_headless"
  },
  "workload": [
    { "key": "list", "kind": "query-core", "table": "Orders", "query": { "limit": 50 } },
    {
      "key": "update",
      "kind": "write-update",
      "table": "Orders",
      "field": "Amount",
      "rows": 5,
      "batchSize": 5,
      "typecast": false,
      "value": { "kind": "number-increment", "start": 1, "step": 1 }
    },
    { "key": "drain", "kind": "flush-computed" }
  ],
  "oracle": [
    {
      "key": "invariants",
      "kind": "invariant",
      "checks": [
        { "type": "row-count", "table": "Orders", "expected": 100 },
        { "type": "computed-not-null", "table": "Orders", "fields": ["Tax", "TaxLabel"] }
      ]
    }
  ],
  "budgets": { "sloP95Ms": null, "budgetModelVersion": null },
  "links": { "requirementIds": [], "issueIds": [] }
}
```

The case ID is computed from the canonical schema, the recomputed dataset identity, generator version, workload, and oracle. Data identity is always recalculated and compared with `dataset.dataHash`: recipe cases hash `{ rows, recipe, seed }`; materialized cases hash `{ rows, seed, csvEntries }` with CSV entry names sorted. A changed row count, seed, recipe, or CSV byte therefore changes the case ID, and a stale `dataHash` is rejected. Use generated manifests or `computeCaseId`/`computeDatasetHash` rather than hand-writing IDs. Top-level unknown keys, duplicate workload/oracle keys, and empty workload/oracle arrays are rejected. `run` defaults to the settings shown above when omitted.

Data modes:

- `recipe` deterministically generates non-computed storage values and then links records. Recipes support `nullFraction`, `distribution` (`uniform`, `zipf`, `constant`, `clustered`), `cardinality`, `min`, `max`, `width`, `choices`, `ratingMax`, and `link` (`table`, `relationship`, optional `fanout`). Domain-valid nullable primaries and rating maxima from the imported schema are preserved; benchmark code does not add a non-null primary constraint.
- `materialized` reads `tables/<declared-table-id>.csv` or `tables/<table-name>.csv` from the archive and requires `dataset.dataHash`. Headers are field names or declared IDs. Link values refer to target primary values or record IDs. Every schema table needs a row count; zero-row tables need no CSV.

Operations are `query-core`, `query-structured`, `write-create`, `write-update`, `write-delete`, and `flush-computed`. A repetition is an independently scheduled group of experiments. Every measured sample creates a fresh runtime/base, imports and seeds the same fixture outside operation timing, then executes the complete workload once in declaration order. Thus update and flush in one sample observe that sample's preceding state, while no create/update/delete/queue state leaks into another sample. Sample setup is reported separately as `sample-setup`. Warmup uses its own fresh disposable fixture per pass and executes the same complete ordered workload, checkpoints and final oracle; warmup timings and reference caches are discarded before measured samples start.

Oracles are `expected-json`, `invariant`, and `full-recompute`. Checkpoints run at their declared workload positions in every fresh sample. Full recompute rebuilds storage in another runtime but uses the same Teable calculation engine as the incremental path; agreement proves incremental state and engine-driven reconstruction are consistent, not that an independent semantic implementation validated the formula. Its default cap is 10,000 copied rows across recreated tables.

## Report and evidence contract

Run reports include case/run IDs, commit, timestamps, backend/environment, setup phases, per-repetition receipts and operation measurements. p50/p95/p99 are mathematical nearest-rank summaries of observed samples; a mathematical percentile is not automatically sufficient statistical evidence. Low-sample runs retain those descriptive values but carry `bench.workload.percentile_evidence_low` and cannot produce a conclusive performance verdict. Correctness/execution and performance are separate: correctness pass never implies performance pass. Without a declared SLO or defensible baseline comparison, performance remains `not-compared` or `inconclusive`.

The evidence gate is about nearest-rank resolution, not a universal reliability claim: for percentile p, require at least `ceil(1/(1-p))` independent samples before it can select below the sample maximum (p95: 20, p99: 100). Fewer samples still produce a mathematical value, often the maximum, but cannot support a performance pass. Meeting this minimum does not establish confidence, tail stability, stationarity, or production representativeness. Current standalone SLO decisions concern p95 only; p99 is descriptive and explicitly subject to its separate resolution limit. A no-SLO run with enough p95 resolution is `not-compared`; a lower-resolution run is performance-`inconclusive` even when correctness passes. Configured warmup executes the full workload on a disposable runtime which is closed before all measured samples, so no sample inherits a specially warmed fixture runtime or its full-recompute reference cache.

`--evidence` writes one validated canonical `tea-bench-report/2` JSON document. Teable row export remains available through `report export-teable`; the run command does not write a second or legacy row shape. Neither command connects to Teable or sends credentials/data over the network.

`--evidence` automatically captures current factual provenance and hashes before execution, then combines them with actual run receipts. Optional `--evidence-input` contains only user-selected catalogue scope and planned receipts; it cannot provide or override commit, host, versions, hashes, artifacts, or performance verdict. With no baseline the canonical performance verdict is `not-compared`. Materialized CSV identity hashes the canonical `{ rows, seed, sorted csvEntries }` values while `fixtureHash` remains the whole-archive digest. Recorded inputs use the archive path actually executed, including a `--tea` override. The reproduction command uses the captured executable/entrypoint, the effective backend/sample/warmup/repetition overrides, a required output path, and never embeds a PostgreSQL connection string; set `TEABLE_BENCH_CONNECTION` to replay against the same isolated database. Historical imports stay explicitly `legacy-unknown`; current host facts are never filled in retroactively.

`compare` does not pair ordinary independent invocations by array index. Current run reports do not carry a common randomized block/arm/protocol identity, so comparisons are descriptive only: they show baseline p95, candidate p95, and their p95 ratio, emit `bench.compare.pairing_evidence_missing`, and return `inconclusive`. There is no regression-threshold option because no threshold can turn unpaired observations into a paired decision. A declared candidate `sloP95Ms` is evaluated independently against candidate p95 only when the run has enough samples for the harness's stated evidence rule; exceeding it fails with the configured `sloSource`.

### Human-friendly report layers

`report render-html --input <canonical-report.json> --out <report.zh.html>` produces a standalone accessible Chinese HTML document with no external dependencies, scripts, fonts or external links. It does not alter the JSON. The HTML and Markdown are projections of the validated `tea-bench-report/2` source of truth; `report export-teable` continues to emit the existing five normalized row groups without connecting to a Teable server.

Read the HTML from its flowchart-first opening: **运行结论** separates correctness/execution/performance, then **业务数据与操作流程** shows the declared business topology and lifecycle before the detailed evidence. Next, **正确性凭据** shows literal expected versus actual values and check methods; **性能数据 / 操作时间线** explains reads, writes and drains while labeling low-sample evidence; **测了什么、没有测什么** identifies the dataset and exclusions; **覆盖范围与缺口** distinguishes planned, executed, skipped and unsupported work; **警告与局限** preserves PGlite and full-recompute boundaries; and the collapsed **环境、来源与复现** plus technical appendix retain provenance, hashes, commands, artifact paths and full identifiers. “正确性通过” never implies exhaustive feature coverage or performance pass.

## Backend notes

Each run imports its own base, and the harness removes that base again on close: base metadata rows, base-scoped computed/event/query-ops rows, and the physical base schema are deleted, and every distinct PostgreSQL meta/data pool is destroyed. Cleanup is limited to base IDs the runtime created, so an unrelated base in the same database survives; the PostgreSQL integration test proves both properties. PGlite destroys its in-memory instance. If a process is killed mid-run, the database may retain that run's base — point `--connection` at a disposable database (the integration tests start throwaway `postgres:16-alpine` containers) or drop it manually.

Writes are timed as the command acknowledgement plus link updates. Some computation occurs inline and the remainder in explicit drain steps, so both phases are reported. Sample setup/import/seed is outside operation samples and reported separately.
