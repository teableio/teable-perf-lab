# teable-perf-lab

Agent-facing context for Teable performance regression cases. Treat this file as
the project map, not a product overview.

This repo defines reproducible perf cases and runs them through the existing
`teable-ee` e2e harness. GitHub Actions checks out `teable-ee`, injects this
repo, prepares a reusable seed database dump, and restores that dump into
isolated V1/V2 execute jobs. The measured operation runs after seed data is
ready.

## Read Order

- Adding or changing a case: read [.agents/README.md](.agents/README.md) next and
  draft the case spec before coding.
- Changing seed/cache behavior: read
  [.agents/seed-execute.md](.agents/seed-execute.md).
- Adding a runner: read [.agents/runners.md](.agents/runners.md), then
  [.agents/new-runner-contract.md](.agents/new-runner-contract.md) only if reuse or
  extension cannot express the case.
- Verifying a case locally before handing it back: read
  [.agents/skills/localrun/SKILL.md](.agents/skills/localrun/SKILL.md). A case
  is not done until it has passed a local v1+v2 run with verified artifacts.
- Running the GitHub workflow: read
  [docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md). That file
  owns trigger commands and workflow inputs.

## File Map

- `perf-lab.e2e-spec.ts`: executable e2e entrypoint copied into `teable-ee`.
- `registry.ts`: registered runnable cases and manual aliases.
- `cases/**/*.case.ts`: typed case configs.
- `cases/**/*.md`: same-name case descriptions used by registry sync.
- `framework/runners/*.runner.ts`: runner implementations.
- `framework/runners/*-model.ts`: pure workload models for runner-owned naming,
  fixture shape, expected values, and config validation. Keep Teable I/O in the
  runner adapter; keep deterministic model logic here.
- `framework/runners/conditional-query-workload.ts`: the grouped-fanout workload
  model shared by conditional-query seed generation, mutation targeting,
  expected values, and result-shape metrics.
- `framework/runner-registry.ts`: the canonical typed runner inventory. Each
  entry keeps its runner-specific `{ execute, seed }` functions together with
  lifecycle/direct metadata; execute and seed cross one dynamic dispatch seam,
  and the migration tracker is generated from this inventory.
- `framework/types.ts`: the `PerfCaseConfigByRunner` map that binds each runner kind
  to its case config interface, plus `PerfRunnerKind`, the `PerfCase` discriminated
  union derived from that map, and result types.
- `framework/seed-cache.ts`: runner-level seed hash helpers.
- `.github/workflows/teable-ee-e2e-perf.yml`: seed job, execute jobs, artifacts,
  report, and Teable registry sync.
- `scripts/perf-artifact-read-model.mjs`: read-side artifact file discovery,
  payload projection, primary metric, trace URL, and trace-waste helpers used by
  report adapters.
- `scripts/perf-run-summary-model.mjs`: Feishu summary projection and card model;
  keep webhook/GitHub I/O in `scripts/send-feishu-perf-summary.mjs`.
- `framework/trace-evidence-policy.ts`: pure trace selection, request-shape,
  fallback, and unfetched-evidence policy; the collector owns capture, fetch,
  and filesystem I/O.
- `scripts/performance-track-record-model.mjs`: Performance Track field
  contract, result-record construction, upsert, and baseline selection shared
  by Teable and in-memory adapters.
- `scripts/perf-artifact-diff-model.mjs`: artifact normalization and mask profile
  for behavior-preserving artifact diffs; keep CLI file I/O in
  `scripts/diff-artifacts.mjs`.
- `.agents/*.md`: agent workflow and implementation rules.

## Hard Rules

- Keep changes inside this repo unless the user explicitly asks otherwise.
- Do not edit `../teable-ee` for perf-lab case implementation.
- Every runnable case needs `cases/<group>/<name>.case.ts`, same-name `.md`, and
  both its `registry.ts` import and an entry in the registered `cases` array
  (`pnpm check:catalog` fails loud if disk, imports, and that array disagree).
- Shared execution behavior belongs in `framework/`.
- Keep fixture data deterministic so V1, V2, and repeated runs compare.
- Run `pnpm check` before finishing code or documentation changes.

## Current Execution Model

Every non-trivial case has two stages:

- **Seed**: create deterministic source tables, fields, records, links, and
  lookup keys. This stage may be reused.
- **Execute**: run the measured operation against a ready seed. This stage must
  be fresh every run.

CI uses two cache layers:

- **Workflow seed DB cache**: GitHub Actions restores/saves
  `perf-lab-seed-cache/e2e_test_teable.dump`. Its key is runner OS, normalized
  case filter, database schema hash, and perf-lab case/framework source hash.
  It deliberately does not include the target `teable-ee` commit ref.
- **Runner `seedHash`**: each runner decides whether tables inside the restored
  dump match its current case config and seed code. If the hash-derived table
  exists and `seedReady` passes, row import is skipped. If validation fails, the
  runner deletes the stale fixture and rebuilds it.

The schema hash is computed from the same four `teable-ee` path groups used in
the workflow:

```text
teable-ee/packages/db-main-prisma/prisma/postgres/schema.prisma
teable-ee/packages/db-main-prisma/prisma/postgres/migrations/**
teable-ee/community/packages/db-data-prisma/prisma/schema.prisma
teable-ee/community/packages/db-data-prisma/prisma/migrations/**
```

Non-schema `teable-ee` code changes do not change the workflow seed DB cache
key; Prisma schema or migration changes do.

Actual workflow behavior:

- Exact seed DB cache hit: the seed job only checks that the dump file exists.
  It skips dependency install, app startup, seed mode, and seed validation.
- Cache miss or restore-key hit: the seed job starts Teable, restores any
  available dump if possible, runs `PERF_LAB_MODE=seed`, lets cache-aware runners
  validate/build their fixtures, then saves a new exact-key dump.
- The seed job uploads its selected dump as a workflow artifact. Execute jobs
  download that same-run artifact into separate V1/V2 Postgres containers, set
  the target engine, and run measured operations. Cache-aware runners run
  `seedReady`/`sourceReady` again before execute. Destructive cases may mutate
  their isolated execute database.

Every runner with a seed fixture is cache-aware; only `http-endpoint` (no
fixture) and `record-paste` / `csv-import` create-table mode (the workload
builds the table) are not. Cleanup strategy is decided by how the measured
operation mutates the seed — see the A/B/C/D taxonomy in
[.agents/seed-execute.md](.agents/seed-execute.md).

Paste cases intentionally keep the 10k inserted rows in the execute stage
because the paste import is the measured operation. Their reusable seed is only
an empty table shape, so caching it would not remove the expensive measured
workload.

## Available Cases

<!-- Generated from registry.ts and each case's `## Goal` section. -->
<!-- Do not edit by hand; run `pnpm sync:readme` to regenerate. -->

- `smoke/auth-user`: Verify that the seeded e2e user can call the authenticated
  user profile endpoint and measure basic request latency.
- `formula/10k-calc`: Measure how long it takes to create one formula field on a
  10k-row table and make the computed values fully readable.
- `formula/10k-5-concurrent`: Measure concurrent creation of five formula fields
  on the same 10k-row table and verify that all computed values become fully
  readable.
- `computed-outbox/bullmq-pause-recovery-20k`: Prove that a temporary BullMQ
  pause becomes visible in the Computed Outbox monitor while a 20,000-record
  depth-four formula update is waiting, then prove that resuming the queue drains
  the durable backlog without failed jobs or dead letters and makes every
  computed value correct.
- `computed-outbox/formula-chain-update-1k-depth4`: Measure the baseline V2
  hybrid seed-task path: one external bulk update of 1,000 records beneath a
  four-level same-table formula chain is durably queued before the Worker plans
  and executes the computed dependency graph.
- `computed-outbox/formula-chain-update-1k-depth8`: Measure the real
  write-to-readable window when V2 hybrid queues a 1,000-record `seed` task and
  the Worker plans and executes an eight-level same-table formula chain.
- `computed-outbox/formula-chain-update-20k-depth4-backlog`: Measure whether one
  20,000-record source update beneath a four-level formula chain creates a
  visible V2 hybrid Computed Outbox backlog, then prove that the Worker catches
  up, the queue drains without dead letters, and every computed value becomes
  correct.
- `computed-outbox/formula-chain-update-5001-depth2`: Measure the V2 hybrid
  task-splitting path caused by one bulk user write carrying 5,001 seed records,
  one record beyond the current 5,000-record maximum per Outbox task, while
  keeping the same-table formula chain only two levels deep.
- `computed-outbox/formula-backfill-20k`: Measure formula-field creation on a
  populated 20,000-row table and prove that V2 hybrid uses a Computed Outbox
  field-backfill task once the table-size estimate is beyond the current
  10,000-row asynchronous threshold.
- `computed-outbox/observer-polling-ab-10k`: Measure whether sampling the
  Computed Outbox database every 5 ms materially changes the observed propagation
  time of the same 10,000-record depth-four formula update compared with a 50 ms
  observer interval.
- `lookup/conditional-10k`: Measure conditional lookup creation on two 10k-row
  tables where every host row matches a different source row through a unique
  key.
- `rollup/conditional-10k`: Measure conditional rollup creation on two 10k-row
  tables where every host row aggregates a different source row through a
  unique-key condition, paired with `lookup/conditional-10k` for V1/V2
  comparison.
- `lookup/conditional-group-text-fanout10-10k`: Measure adding a conditional
  text lookup to a 10k-row host where every row resolves 10 records from a
  10k-row source.
- `lookup/conditional-group-text-fanout50-10k`: Measure the middle of the
  conditional text-lookup scale curve by returning 50 matching values for every
  row of a 10k host.
- `lookup/conditional-group-text-fanout100-10k`: Measure a customer-like
  high-volume conditional text lookup that returns 100 matching values for every
  row of a 10k host.
- `lookup/conditional-group-text-update-1k-fanout10-10k`: Measure conditional
  text-lookup propagation when each of 10,000 host rows resolves 10 source values
  and 1,000 source values change.
- `lookup/conditional-group-text-update-1k-fanout50-10k`: Measure conditional
  text-lookup propagation when each of 10,000 host rows resolves 50 source values
  and 1,000 source values change.
- `lookup/conditional-group-text-update-1k-fanout100-10k`: Measure how long a
  populated conditional text lookup takes to become fully correct after 1,000
  source values change.
- `lookup/conditional-group-text-update-1k-fanout100-limit10-10k`: Measure
  propagation when every host row sorts 100 matching source records but stores
  only the first 10 text values after a source update.
- `lookup/conditional-group-text-update-1k-fanout100-limit50-10k`: Measure
  propagation when every host row sorts 100 matching source records but stores
  only the first 50 text values after a source update.
- `lookup/conditional-group-text-update-1k-fanout100-20k`: Measure conditional
  text-lookup propagation when the same 1,000-record source update invalidates a
  20,000-row host.
- `lookup/conditional-group-text-update-1k-fanout100-30k`: Measure conditional
  text-lookup propagation when the same 1,000-record bulk update fans out across
  a 30,000-row host.
- `lookup/conditional-group-number-top3-10k`: Measure adding a conditional
  number lookup that selects the top three of 10 matching source rows for every
  row of a 10k host.
- `lookup/conditional-group-number-top3-fanout50-10k`: Measure conditional
  top-three lookup cost when each row of a 10k host sorts 50 candidates but still
  returns only three numbers.
- `lookup/conditional-group-number-top3-fanout100-10k`: Measure a high-volume
  conditional top-three lookup where each row of a 10k host sorts 100 candidates
  but returns only three numbers.
- `lookup/conditional-group-active-text-10k`: Measure adding a conditional text
  lookup with a dynamic group condition plus a static active-state condition on a
  10k host.
- `lookup/conditional-group-active-text-fanout50-10k`: Measure the middle of a
  multi-condition text-lookup scale curve where half of 50 group matches remain
  active for every row of a 10k host.
- `lookup/conditional-group-active-text-fanout100-10k`: Measure a high-volume
  multi-condition text lookup where half of 100 group matches remain active for
  every row of a 10k host.
- `lookup/conditional-group-active-flip-1k-fanout100-10k`: Measure conditional
  lookup propagation when 1,000 source records stop matching the active-state
  predicate.
- `lookup/conditional-group-active-flip-1k-fanout100-30k`: Measure conditional
  lookup propagation when 1,000 predicate changes invalidate a 30,000-row host.
- `rollup/conditional-group-countall-fanout10-10k`: Measure adding a conditional
  count-all rollup over 10 matching source rows for every row of a 10k host.
- `rollup/conditional-group-sum-fanout10-10k`: Measure adding a conditional
  numeric sum over 10 matching source rows for every row of a 10k host.
- `rollup/conditional-group-average-fanout10-10k`: Measure adding a conditional
  numeric average over 10 matching source rows for every row of a 10k host.
- `rollup/conditional-group-active-max-10k`: Measure adding a conditional
  maximum with dynamic group matching and a static active-state condition on a
  10k host.
- `rollup/conditional-group-active-sum-fanout10-10k`: Measure the baseline of a
  customer-like conditional amount sum on a 10k-row host, using dynamic group
  matching plus an active-state condition.
- `rollup/conditional-group-active-sum-fanout50-10k`: Measure the middle of the
  conditional amount-sum scale curve by increasing source fanout to 50 while
  keeping the 10k host and field configuration unchanged.
- `rollup/conditional-group-active-sum-fanout100-10k`: Measure a customer-like
  high-computation conditional amount sum on 110k total records without
  reproducing the full 120k-plus customer table.
- `rollup/conditional-group-active-sum-update-1k-fanout10-10k`: Measure
  conditional sum propagation when each of 10,000 host rows aggregates five
  active values from 10 group matches and 1,000 source amounts change.
- `rollup/conditional-group-active-sum-update-1k-fanout50-10k`: Measure
  conditional sum propagation when each of 10,000 host rows aggregates 25 active
  values from 50 group matches and 1,000 source amounts change.
- `rollup/conditional-group-active-sum-update-1k-fanout100-10k`: Measure how
  long an existing conditional sum takes to recompute after 1,000 active source
  amounts change.
- `rollup/conditional-group-active-sum-update-1k-fanout100-20k`: Measure
  conditional sum propagation when the same 1,000-record source update
  invalidates 20,000 host aggregates.
- `rollup/conditional-group-active-sum-update-1k-fanout100-30k`: Measure
  conditional sum propagation when the same 1,000 amount changes invalidate
  30,000 host aggregates.
- `rollup/conditional-group-text-top3-10k`: Measure adding a conditional text
  array-join over the top three of 10 matching source rows for every row of a 10k
  host.
- `lookup/dual-link-computed-first-link-4k`: Measure how long after a data write
  the V2 dependency graph becomes readable, on a deep, customer-mirrored schema.
  After the order links are written, every dependent lookup, multi-level formula,
  and downstream cross-table rollup must recompute. This reproduces the customer
  "orders" scenario where the links (`customer_id_fk`, `gust_email_fk`) had
  record ids immediately but the lookups (`user_email`, `shipping_first_name`,
  ...) and the `${first_name} ${last_name}` formula were still null for a window,
  producing `undefined undefined`. This `first-link` variant is the closest to
  the customer "new record first association" worst case: orders start with no
  customer/guest link at all.
- `lookup/dual-link-computed-repoint-2k`: Measure how long after a data write
  the V2 dependency graph becomes readable, on a deep, customer-mirrored schema,
  when the links already exist and are re-pointed to different records. This is
  the `A -> B` switch variant of `lookup/dual-link-computed-first-link-4k`:
  orders are seeded already linked, then every link is re-pointed, forcing all
  dependent lookups, multi-level formulas, and downstream cross-table rollups to
  recompute. It reproduces the customer "orders" scenario where the link targets
  change but the lookups (`user_email`, `shipping_first_name`, ...) and the
  `${first_name} ${last_name}` formula lag for a window.
- `search/search-index-off-10k-20search-fields`: Measure global
  `aggregation/search-index` latency on the 10k-row host table whose
  `TableIndex.search` is disabled.
- `search/search-index-on-10k-20search-fields`: Measure global
  `aggregation/search-index` latency on the 10k-row host table whose
  `TableIndex.search` is enabled.
- `search/search-index-off-50k-20search-fields`: Measure global
  `aggregation/search-index` latency on the 50k-row host table whose
  `TableIndex.search` is disabled.
- `search/search-index-on-50k-20search-fields`: Measure global
  `aggregation/search-index` latency on the 50k-row host table whose
  `TableIndex.search` is enabled.
- `field-create/10k-create-5-simple-fields`: Measure create-request latency for
  adding 5 simple fields to a 10,000-record table. This case is paired with
  `field-create/10k-create-5-formula-fields` to compare whether the request
  latency layer is close when formula calculation completion is not measured.
- `field-create/10k-create-5-formula-fields`: Measure create-request latency for
  adding 5 formula fields to a 10,000-record table, then separately verify how
  long it takes after the create responses for the formula values to be correct
  in the underlying physical table columns. The create-request metric can be
  compared with `field-create/10k-create-5-simple-fields` at the request latency
  layer, while the ready metric captures post-create storage readiness without
  using records API pagination as the readiness signal.
- `field-create/mixed-10k-create-19-fields`: Measure the external field creation
  path for adding 19 mixed-type fields to a 10,000-row table.
- `field-create/single-select-1k-options`: Measure the field creation path for
  adding one single select field with 1,000 deterministic options.
- `field-convert/10k-multi-select-to-text`: Catch regressions in converting a
  populated multiple select column to single line text on a 10k-row grid — the
  standard field type conversion path that rewrites every cell value of the
  column (`PUT /table/{tableId}/field/{fieldId}/convert`, canary feature
  `convertField`).
- `field-convert/10k-text-to-formula`: Catch regressions in converting a
  populated text column into a computed formula field on a 10k-row grid — the
  complex conversion path that discards old cell values and recomputes the whole
  column (`PUT /table/{tableId}/field/{fieldId}/convert`, canary feature
  `convertField`).
- `field-convert/10k-link-to-text`: Catch regressions in converting a populated
  many-one link field into single line text on a 10k-row grid — the conversion
  that breaks link semantics and freezes the linked display titles into plain
  text across every row.
- `field-convert/10k-text-to-link`: Catch regressions in converting a populated
  text field into a many-one link field on a 10k-row grid — the reverse of
  `field-convert/10k-link-to-text`. It turns text values that name foreign
  records into real linked records, stressing text-title matching, link
  relationship creation, and relationship value rewrite.
- `field-update/v2-only-10k-select-option-rename-computed-cascade`: Catch
  regressions in the V2 field update path when renaming a populated single-select
  option forces dependent computed fields to recalculate across a 10,000-row
  table. V2-only diagnostic: legacy updateField cannot express select option
  rename, so V1 returns a skipped artifact and the case never enters V1/V2
  comparison.
- `field-delete/mixed-10k-delete-19-fields`: Measure the bulk field delete path
  for removing 19 mixed-type fields from a 10,000-row table in one request.
- `field-restore/10k-description-field`: Measure restoring one deleted populated
  text field on a 10,000-row mixed table, including the field schema restore and
  every row's cell value restoration.
- `field-duplicate/conditional-lookup-10k`: Measure duplicating the conditional
  lookup field from the `lookup/conditional-10k` workload.
- `duplicate-table/10k-20f`: Measure duplicating a 10,000-record mixed 20-field
  table with records included.
- `duplicate-table/10k-25f-5formula`: Measure duplicating a 10,000-record
  complex mixed table with 25 stored fields, 5 formula fields, and records
  included.
- `duplicate-table/10k-20f-selflink`: Measure duplicating a 10,000-record mixed
  20-field table that includes a self manyMany link with records. Exercises the
  V2 physical bulk path for self-link tables (T6156 follow-up).
- `duplicate-base/10k-3tables-link-2workflow`: Measure duplicating a base that
  contains a 10,000-record mixed 20-field main table, a 1,000-record table linked
  to it, a 100-record small table, and 2 workflows, with records included.
- `duplicate-base/10k-3tables-link-2workflow-stream`: Measure duplicating a base
  through the product SSE progress path when the base contains a 10,000-record
  main table, a 1,000-record linked table, a 100-record small table, and 2
  workflows.
- `import-base/v2-only-simple-1x1k-table-stream`: Measure importing a simple
  `.tea` base file through the V2 product SSE progress path when the imported
  base contains one independent 1,000-record table.
- `import-base/v2-only-simple-1x10k-table-stream`: Measure importing a simple
  `.tea` base file through the V2 product SSE progress path when the imported
  base contains one independent 10,000-record table.
- `import-base/v2-only-complex-3x10k-3tables-2workflow-stream`: Measure
  importing a more complex `.tea` base file through the V2 product SSE progress
  path when the imported base contains three independent 10,000-record tables and
  workflow metadata.
- `import-base/v2-only-user-t2377-tea-stream`: Measure importing the
  user-provided `T2377.tea` package through the V2 product SSE progress path when
  the imported base contains many real tables, fields, views, one app package,
  and workflow metadata.
- `export-base/10k-3tables-link-2workflow-stream`: Measure exporting a base
  through the product SSE progress path when the base contains a 10,000-record
  main table, a 1,000-record linked table, a 100-record small table, and workflow
  metadata.
- `table-create/10x-20f-no-records`: Measure creating 10 tables, each with 20
  mixed fields and no records, sequentially inside one timed window.
- `table-create/1x-20f-1k-records`: The data-scaling variant of `createTable`:
  create one mixed 20-field table whose `POST /api/base/{baseId}/table` request
  body carries **1,000 inline records**, so the measured cost includes the record
  insertion that the no-records variant deliberately excludes.
- `table-create/1x-20f-5k-records`: Scale `table-create/1x-20f-1k-records` by
  5x: create one mixed 20-field table whose measured request carries 5,000
  deterministic inline records.
- `table-delete/10k-20f`: Measure repeated archive-to-trash requests for 10
  independent 10,000-record mixed 20-field tables in one run.
- `table-delete/10k-20f-link-detach`: The data-scaling path of `deleteTable`:
  archive a small foreign table while a 10,000-record mixed 20-field table still
  links to it.
- `table-restore/10k-20f`: Measure repeated restore requests for 10 independent
  10,000-record mixed 20-field tables from the base trash in one run.
- `table-restore/10k-20f-link-1k`: Data-scaling sentinel for `restoreTable`:
  restore 5 independent 10,000-record mixed 20-field tables that each own a
  **populated one-way link field** (10,000 link cells pointing at a 1,000-record
  foreign table).
- `csv-import/mixed-1k-20fields-create-table-import`: Measure CSV import that
  creates a new table through `POST /api/import/{baseId}`. This covers the
  product path where a user uploads a CSV file and imports it as a new table. V1
  and V2 runs execute the same user-facing behavior, with the same CSV data,
  endpoint shape, readiness checks, and cleanup.
- `csv-import/mixed-10k-20fields-create-table-import`: Measure CSV import that
  creates a new table through `POST /api/import/{baseId}` with 10,000 rows and 20
  mixed columns. This covers the product path where a user uploads a larger CSV
  file and imports it as a new table.
- `csv-import/mixed-10k-20fields-inplace-import`: Measure CSV import into an
  existing mixed 20-field table through `PATCH /api/import/{baseId}/{tableId}`.
  This covers the product path where a user uploads CSV data and appends it to a
  table whose field types already exist.
- `form-submit/sequential-200`: Catch regressions in the public form-submission
  path by submitting 200 records through a Form view one request at a time and
  measuring per-submit p95 latency.
- `selection-clear/flat-1k-20fields-cell-clear-stream`: Measure the grid
  selection-clear stream path for clearing every visible cell across 1,000 rows
  and 20 mixed fields through
  `PATCH /api/table/{tableId}/selection/clear-stream`.
- `record-delete/delete-1k`: Measure the grid selection delete path for deleting
  1,000 mixed-type records from a 20-field table.
- `record-delete/delete-stream-1k`: Measure the grid **streaming**
  selection-delete path for deleting every record of a 1,000-row, 20-field table.
  This is the streaming sibling of `record-delete/delete-1k`: the product
  switches a selection delete to the stream endpoints once the affected row count
  crosses ~200, so a 1k delete in the real UI never uses the synchronous endpoint
  the sync case measures.
- `record-delete/delete-stream-10k`: Measure the grid **streaming**
  selection-delete path for deleting every record of a 10,000-row, 20-field
  table. This is the larger-scale sibling of `record-delete/delete-stream-1k`:
  same runner, same per-engine dispatch, 10x the rows. 10k is where the V1 legacy
  range stream's O(n) cost (if any) shows against the V2 by-id stream, so this
  case carries the real V1/V2 spread; the 1k case covers correctness and routing
  at small scale.
- `record-delete/link-trash-1k`: Measure deleting 1,000 records from a table
  whose rows contain populated link cells, covering the record-trash path for
  linked records rather than plain scalar-row deletion.
- `record-read/10k-50fields-10x1k-pages`: Measure
  `GET /api/table/{tableId}/record` latency for reading a full 10,000-row table
  as ten sequential maximum-size 1,000-record pages with 50 projected fields,
  including stored lookup columns and formula values.
- `record-read/10k-50fields-filter-sort-groupby-overhead`: Measure the extra
  cost of adding explicit filter, sort, and groupBy query semantics to the same
  10,000-row, 50-projected-field read workload used by
  `record-read/10k-50fields-10x1k-pages`.
- `record-create/mixed-1k-20fields-bulk-create`: Measure
  `POST /api/table/{tableId}/record` for creating 1,000 typed records in one
  request against an empty 20-field mixed table.
- `record-duplicate/grid-block-duplicate-1k`: Catch regressions in the grid
  duplicate selected rows path by duplicating a block of 1,000 rows in a
  10,000-row mixed table through
  `GET /api/table/{tableId}/selection/duplicate-stream`.
- `record-duplicate/single-record-sequential-100`: Catch regressions in the
  single-record duplicate path by duplicating 100 distinct records one request at
  a time through `POST /api/table/{tableId}/record/{recordId}/duplicate`.
- `record-update/mixed-1k-20fields-bulk-update`: Measure OpenAPI bulk record
  update performance for updating 1,000 existing records across 20 mixed fields
  through `PATCH /api/table/{tableId}/record`.
- `record-update/attachment-insert-100`: Measure bulk insertion of attachment
  references into 100 existing records. This isolates attachment payload
  validation and attachment cell serialization from the scalar bulk-update path,
  matching the product action of attaching files to many records at once.
- `record-update/attachment-insert-1k`: Measure bulk insertion of two attachment
  references into 1,000 existing records, providing a higher-signal sibling to
  the 100-record attachment case.
- `record-update/1k-link-cells-bulk-update`: Measure bulk editing of 1,000
  many-one link cells. Updating link cells stresses link-target resolution,
  relationship writes, and link display-value refresh differently from the scalar
  bulk-update path, matching the product action of re-pointing linked records
  across many rows.
- `record-reorder/10k-move-last-1k-to-front`: Measure block reorder performance
  in a 10,000-row grid by moving the original last 1,000 visible records to the
  front in one operation.
- `record-undo/delete-1k`: Measure undo replay performance after a user deletes
  1,000 mixed-type records through the grid selection delete path.
- `record-redo/delete-1k`: Measure redo replay performance after a user deletes
  1,000 mixed-type records and then undoes that delete.
- `record-paste/flat-10k-20fields-copy-paste`: Measure the grid paste API path
  for inserting 10,000 flat records into an empty 20-field table through
  `PATCH /api/table/{tableId}/selection/paste`.
- `record-paste/flat-10k-4fields-copy-paste`: Measure the grid paste API path
  for inserting 10,000 flat records into an empty table through
  `PATCH /api/table/{tableId}/selection/paste`.
- `record-paste/mixed-10k-20fields-complex-copy-paste`: Measure the grid paste
  API path for inserting 10,000 mixed-type records into an empty 20-field table
  through `PATCH /api/table/{tableId}/selection/paste`.
- `selection-paste/10k-expand-rows-and-fields-stream`: Measure pasting a large
  spreadsheet-shaped block into a smaller grid through the product paste stream
  path, forcing both row expansion and field expansion.

## Case Registry

Developer-facing case metadata is mirrored into the Teable `Perf Cases` table:

- Base: `bselS3I2MeVI6RJhS4g`
- Table: `tbl0pa9PtLeNPCRNCKe`

The table stores the case id, title, owner, tags, runner, threshold, local
reproduce command, GitHub Actions reproduce command, and a GitHub URL for the
case description markdown. The sync source of truth is the repository:

- `cases/<group>/<case>.case.ts` defines executable behavior and thresholds.
- `cases/<group>/<case>.md` explains the data setup, operation, and metric.
- `registry.ts` decides which cases are runnable.

Run `pnpm check:cases` to validate the registry and markdown descriptions
without writing Teable. Run `pnpm sync:cases` with `TEABLE_PERF_LAB_TOKEN` to
upsert the table locally. GitHub Actions also runs `Sync perf cases` on pushes
to `main` that touch case definitions, descriptions, registry, or the sync
script, so the Teable table stays aligned with the repo.
