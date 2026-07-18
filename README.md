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
- `formula/50k-calc`: Measure creating one formula field and making all computed
  values readable on a 50,000-row table.
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
- `lookup/dual-link-computed-first-link-1of4k-get-record`: Measure the
  customer-visible lookup gap after first-linking one order inside a 4,000-row
  deep computed graph, using the direct single-record API as the readiness path.
  This separates single-write fixed latency from the bulk throughput measured by
  `lookup/dual-link-computed-first-link-4k`.
- `lookup/dual-link-computed-first-link-1of4k-get-records`: Measure the
  customer-visible lookup gap after first-linking one order inside a 4,000-row
  deep computed graph, using the filtered record-list API that matches the
  customer's write-then-query pattern. Paired with the direct-record variant,
  this tests whether `getRecords` observes computed readiness later than
  `getRecord` under otherwise identical conditions.
- `lookup/dual-link-computed-repoint-2k`: Measure how long after a data write
  the V2 dependency graph becomes readable, on a deep, customer-mirrored schema,
  when the links already exist and are re-pointed to different records. This is
  the `A -> B` switch variant of `lookup/dual-link-computed-first-link-4k`:
  orders are seeded already linked, then every link is re-pointed, forcing all
  dependent lookups, multi-level formulas, and downstream cross-table rollups to
  recompute. It reproduces the customer "orders" scenario where the link targets
  change but the lookups (`user_email`, `shipping_first_name`, ...) and the
  `${first_name} ${last_name}` formula lag for a window.
- `lookup/foreign-select-flip-1of40-fanout100-4k`: Measure the customer-visible
  propagation gap when one cell on a linked foreign record changes while every
  order link record id stays unchanged. One User Status update fans out through
  lookups, five formula levels, purchase rollups, and purchase formulas.
- `lookup/foreign-first-name-update-1of40-fanout100-4k`: Measure the same
  unchanged-link propagation path for a normal one-cell text edit. This matches
  the user operation: edit one field once, rather than sending a synthetic
  multi-field update.
- `lookup/customer-update-user-create-order-4k-depth5`: Reproduce the customer
  import order: update an existing User, immediately create a linked Order, then
  read that Order. This tests whether the second write can observe and propagate
  the first write through a long computed dependency chain without an artificial
  delay.
- `lookup/customer-update-user-update-order-4k-depth5`: Reproduce a customer
  upsert where an existing User is updated and an existing linked Order is
  immediately updated. The link record id does not change, so the case exercises
  propagation from both a foreign-table value change and a host record value
  change rather than link creation.
- `lookup/customer-create-user-create-order-4k-depth5`: Reproduce the
  new-customer branch: create a User and immediately create an Order that links
  to the returned record id. This covers a dependency target that did not exist
  when the fixture's computed graph became ready.
- `lookup/customer-create-order-only-4k-depth5`: Measure whether creating a
  fully linked Order has an inherent propagation delay when no User write
  precedes it.
- `lookup/customer-update-user-first-name-only-create-order-4k-depth5`: Measure
  whether changing one User field inside the lookup dependency graph is enough to
  delay an immediately created linked Order, without resubmitting the User title
  or the other nine unchanged profile fields.
- `lookup/customer-update-user-control-field-create-order-4k-depth5`: Measure
  whether any preceding User write delays a linked Order create when the changed
  field is completely outside the lookup and formula dependency graph.
- `lookup/customer-update-other-user-create-order-4k-depth5`: Measure whether a
  User update delays an immediately created Order whose User and Purchase links
  belong to a different dependency subgraph.
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
- `field-convert/10k-single-select-to-text`: Guard conversion of 10,000 scalar
  option values to single-line text.
- `field-convert/10k-number-to-text`: Guard number-to-text conversion and
  formatted value rewrite at 10k rows.
- `field-convert/10k-checkbox-to-text`: Guard conversion of checked and
  unchecked cells to text across 10,000 rows.
- `field-convert/10k-rating-to-text`: Guard conversion of 10,000 option-bearing
  rating values to text.
- `field-convert/10k-long-text-to-text`: Guard multiline long-text normalization
  while converting 10,000 cells to single-line text.
- `field-convert/10k-text-to-number-mixed`: Guard numeric parsing and
  invalid-value clearing while rewriting 10,000 text cells to number storage.
- `field-convert/10k-text-to-single-select`: Guard choice discovery and backfill
  while converting 10,000 text values to a single-select field.
- `field-convert/10k-text-to-multiple-select`: Guard comma-list parsing and
  TEXT-to-JSON rewriting across 10,000 rows.
- `field-convert/10k-text-to-checkbox-mixed`: Guard text truthiness conversion
  across populated and null rows.
- `field-convert/10k-text-to-date-mixed`: Guard ISO parsing and invalid-value
  clearing while converting text to datetime.
- `field-convert/10k-text-to-attachment-clear`: Guard the destructive rewrite
  when incompatible text becomes an attachment field.
- `field-convert/10k-text-to-auto-number`: Guard computed auto-number backfill
  while converting a populated 10,000-row text column.
- `field-convert/10k-number-to-rating-clamped`: Guard number validation and
  upper-bound clamping during rating conversion.
- `field-convert/10k-single-select-choice-prune`: Guard same-type choice rename
  and removal across a populated single-select column.
- `field-convert/10k-multiple-select-choice-prune`: Guard filtering and rename
  semantics over 10,000 multiple-select JSON arrays.
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
- `field-convert/formula-expression-update-4k-depth5-cascade`: Measure a real
  one-field schema edit at the head of a long dependency chain. The formula keeps
  the same lookup dependencies; only its literal output prefix changes. This
  isolates recomputation of an existing graph from dependency-graph rebuild
  cases.
- `field-convert/formula-dependency-add-4k-depth5-cascade`: Measure adding one
  lookup dependency to a populated head formula and rebuilding the resulting
  4,000-order, depth-5 cascade.
- `field-convert/formula-dependency-replace-4k-depth5-cascade`: Measure
  replacing one lookup dependency in a populated head formula, forcing a
  dependency-edge removal and addition in the same 4,000-order schema update.
- `field-convert/formula-dependency-remove-4k-depth5-cascade`: Measure removing
  one lookup dependency from a populated head formula and rebuilding the
  resulting 4,000-order, depth-5 cascade.
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
- `field-restore/10k-status-field`: Measure restoring a populated single-select
  field and all 10,000 option-backed cell values from field trash.
- `field-restore/10k-start-date-field`: Measure restoring a populated date
  field, its formatting metadata, and all 10,000 serialized date values from
  field trash.
- `field-restore/10k-owner-text-field`: Measure restoring a populated
  single-line text field and its 10,000 cell values.
- `field-restore/10k-tags-field`: Measure restoring 10,000 populated
  multiple-select cells from field trash.
- `field-restore/10k-amount-field`: Measure restoring a populated numeric column
  on 10,000 rows.
- `field-restore/10k-active-field`: Measure restoring 10,000 alternating
  checkbox values, including unchecked/null storage semantics.
- `field-restore/10k-score-field`: Measure restoring a populated rating field
  and 10,000 bounded score values.
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
- `duplicate-view/complex-grid-20fields-p95`: Cover the distinct `duplicateView`
  canary route and track p95 latency for a real grid view carrying filters,
  sorts, grouping, and 20 fields of column metadata.
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
- `table-create/1x-1f-1k-primary-only`: Establish the narrowest `createTable`
  baseline by creating one primary-only table with 1,000 inline records in the
  measured request.
- `table-create/1x-10f-1k-single-line-text`: Isolate plain-text inline insertion
  by creating one ten-field text table with 1,000 records in the measured
  `createTable` request.
- `table-create/1x-10f-1k-long-text`: Isolate long-text inline insertion while
  holding the workload at one table, ten fields, and 1,000 records.
- `table-create/1x-10f-1k-number`: Isolate native numeric insertion in a
  `createTable` request carrying 1,000 inline records.
- `table-create/1x-10f-1k-date`: Isolate UTC date insertion and normalization in
  `createTable` with 1,000 inline records.
- `table-create/1x-10f-1k-checkbox`: Isolate checkbox insertion in a ten-field
  table created with 1,000 inline records.
- `table-create/1x-10f-1k-single-select`: Isolate single-select option
  resolution during table creation with 1,000 inline records.
- `table-create/1x-10f-1k-multiple-select`: Isolate native multiple-select array
  insertion during table creation with 1,000 inline records.
- `table-create/1x-10f-1k-rating`: Isolate bounded rating insertion in a
  ten-field table created with 1,000 inline records.
- `table-create/1x-20f-1k-single-line-text`: Measure schema and inline-payload
  width by creating one 20-field text table with 1,000 records in a single
  `createTable` request.
- `table-delete/10k-20f`: Measure repeated archive-to-trash requests for 10
  independent 10,000-record mixed 20-field tables in one run.
- `table-delete/10k-20f-link-detach`: The data-scaling path of `deleteTable`:
  archive a small foreign table while a 10,000-record mixed 20-field table still
  links to it.
- `table-delete/30k-20f-link-detach`: Measure deleting a referenced table while
  30,000 surviving host rows still hold link cells, amplifying the known
  row-dependent V1 `detachLink` work while preserving the V2 soft-delete
  comparison.
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
- `selection-clear/flat-10k-20fields-cell-clear-stream`: Measure clearing every
  visible cell in a 10,000-row, 20-field mixed grid and catch nonlinear
  regressions beyond the existing 1k stream baseline.
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
- `record-delete/delete-stream-30k`: Extend the 1k/10k selection-delete stream
  curve to a 30,000-row workload that can expose nonlinear row-deletion and
  stream-progress regressions.
- `record-delete/link-trash-1k`: Measure deleting 1,000 records from a table
  whose rows contain populated link cells, covering the record-trash path for
  linked records rather than plain scalar-row deletion.
- `record-read/10k-50fields-10x1k-pages`: Measure
  `GET /api/table/{tableId}/record` latency for reading a full 10,000-row table
  as ten sequential maximum-size 1,000-record pages with 50 projected fields,
  including stored lookup columns and formula values.
- `record-read/10k-50fields-filter-text-not-empty`: Measure the overhead of a
  match-all non-empty text filter on a 10,000-row read that projects 50 stored
  and computed fields.
- `record-read/10k-50fields-filter-number-greater-half`: Measure a selective
  numeric filter over a 10,000-row, 50-field projected read.
- `record-read/10k-50fields-filter-number-range-middle-half`: Measure an AND
  range filter with two predicates on the same numeric field.
- `record-read/10k-50fields-search-title-visible-rows`: Measure field-scoped
  grid search when search hides nonmatching rows in a wide 10,000-row read.
- `record-read/10k-50fields-sort-text-ascending`: Measure ascending text sorting
  across a 10,000-row read with 50 projected stored and computed fields.
- `record-read/10k-50fields-sort-three-fields`: Measure a three-column sort over
  a wide 10,000-row record read.
- `record-read/10k-50fields-group-number-low-cardinality`: Measure grouping a
  10,000-row, 50-field read by a seven-value stored number field.
- `record-read/10k-50fields-group-three-levels`: Measure a three-level grouped
  read across low-, medium-, and high-cardinality stored fields.
- `record-read/10k-50fields-filter-number-sort-descending`: Measure the common
  composed path of a selective numeric filter plus descending sort on a
  10,000-row wide read.
- `record-read/10k-50fields-filter-sort-groupby-selective`: Measure the full
  filter, sort, and groupBy path with a selective predicate and low-cardinality
  grouping.
- `record-read/10k-50fields-filter-formula-greater-half`: Measure a selective
  numeric predicate on a computed formula in a wide read.
- `record-read/10k-50fields-filter-formula-range-middle`: Measure an AND range
  filter on a computed numeric expression.
- `record-read/10k-50fields-sort-formula-descending`: Measure sorting a wide
  result set by a computed numeric value.
- `record-read/10k-50fields-filter-sort-formula-selective`: Measure selective
  formula filtering composed with formula sorting.
- `record-read/10k-50fields-group-stored-sort-formula`: Measure stored-field
  grouping with computed ordering inside each group.
- `record-read/10k-50fields-filter-lookup-not-empty`: Measure filtering on a
  computed conditional lookup column.
- `record-read/10k-50fields-search-lookup-visible-row`: Measure field-scoped
  visible-row search on a computed lookup value.
- `record-read/10k-50fields-sort-lookup-ascending`: Measure sorting by a
  computed lookup text value.
- `record-read/10k-50fields-group-stored-sort-lookup`: Measure stored grouping
  with computed lookup ordering inside each group.
- `record-read/10k-50fields-filter-group-sort-formula`: Measure the full
  computed-filter, stored-group, and computed-sort path.
- `record-read/10k-50fields-filter-sort-groupby-overhead`: Measure the extra
  cost of adding explicit filter, sort, and groupBy query semantics to the same
  10,000-row, 50-projected-field read workload used by
  `record-read/10k-50fields-10x1k-pages`.
- `record-read/50k-50fields-50x1k-pages`: Measure a complete 50,000-row read
  through fifty 1,000-row pages while projecting 50 fields, including 20 lookups
  and five formulas.
- `record-create/mixed-1k-20fields-bulk-create`: Measure
  `POST /api/table/{tableId}/record` for creating 1,000 typed records in one
  request against an empty 20-field mixed table.
- `record-create/1k-single-line-text-fields-bulk-create`: Measure one
  1,000-record create request containing the four single-line text fields of a
  20-field mixed table.
- `record-create/1k-long-text-fields-bulk-create`: Measure one 1,000-record
  create request containing only the three long-text fields of a 20-field mixed
  table.
- `record-create/1k-number-fields-bulk-create`: Measure one 1,000-record create
  request containing the three numeric fields of a 20-field mixed table.
- `record-create/1k-date-fields-bulk-create`: Measure one 1,000-record create
  request containing the two UTC date fields of a 20-field mixed table.
- `record-create/1k-checkbox-fields-bulk-create`: Measure one 1,000-record
  create request containing the two checkbox fields of a 20-field mixed table.
- `record-create/1k-single-select-fields-bulk-create`: Measure one 1,000-record
  create request containing the three single-select fields of a 20-field mixed
  table.
- `record-create/1k-multiple-select-fields-bulk-create`: Measure one
  1,000-record create request containing the two multiple-select fields of a
  20-field mixed table.
- `record-create/1k-rating-field-bulk-create`: Measure one 1,000-record create
  request containing only the rating field of a 20-field mixed table.
- `record-create/1k-primary-text-only-bulk-create`: Measure the narrowest
  1,000-record create request: one title field in a one-field table.
- `record-create/1k-wide-table-title-only-bulk-create`: Measure a one-field
  1,000-record create payload against a 20-field mixed table to expose
  schema-width overhead independently of request width.
- `record-duplicate/grid-block-duplicate-1k`: Catch regressions in the grid
  duplicate selected rows path by duplicating a block of 1,000 rows in a
  10,000-row mixed table through
  `GET /api/table/{tableId}/selection/duplicate-stream`.
- `record-duplicate/single-record-sequential-100`: Catch regressions in the
  single-record duplicate path by duplicating 100 distinct records one request at
  a time through `POST /api/table/{tableId}/record/{recordId}/duplicate`.
- `record-duplicate/single-50-primary-only`: Establish the narrowest
  single-record duplicate baseline by copying 50 source records from a table that
  contains only the primary `Title` field.
- `record-duplicate/single-50-single-line-text-10fields`: Isolate single-line
  text copy and response serialization by duplicating 50 records from a
  fixed-width table containing `Title` and nine text fields.
- `record-duplicate/single-50-long-text-10fields`: Isolate larger string copying
  by duplicating 50 records from a table containing primary `Title` plus nine
  deterministic long-text fields.
- `record-duplicate/single-50-number-10fields`: Isolate numeric cloning and
  response conversion in a fixed-width table with primary `Title` and nine number
  fields.
- `record-duplicate/single-50-date-10fields`: Isolate date value copying and
  normalization in a table with primary `Title` and nine UTC date fields.
- `record-duplicate/single-50-checkbox-10fields`: Isolate boolean and
  empty-state copying in a table with primary `Title` and nine checkbox fields.
- `record-duplicate/single-50-single-select-10fields`: Isolate option cloning in
  a table with primary `Title` and nine single-select fields sharing stable
  choice names.
- `record-duplicate/single-50-multiple-select-10fields`: Isolate multi-value
  option-array cloning in a table with primary `Title` and nine multiple-select
  fields.
- `record-duplicate/single-50-rating-10fields`: Isolate bounded rating-cell
  cloning in a table with primary `Title` and nine five-star rating fields.
- `record-duplicate/single-50-mixed-20fields`: Provide a 50-request wide-table
  comparison using the established 20-field mix of text, select, number, date,
  checkbox, and rating cells.
- `record-update/mixed-1k-20fields-bulk-update`: Measure OpenAPI bulk record
  update performance for updating 1,000 existing records across 20 mixed fields
  through `PATCH /api/table/{tableId}/record`.
- `record-update/1k-single-line-text-fields-bulk-update`: Measure one
  1,000-record bulk request that updates the four single-line text fields in the
  shared 20-field scalar fixture.
- `record-update/1k-long-text-fields-bulk-update`: Measure long-text
  serialization and storage in one 1,000-record bulk update.
- `record-update/1k-number-fields-bulk-update`: Measure numeric validation and
  storage for decimal, integer, and percentage-like values in one 1,000-record
  bulk update.
- `record-update/1k-date-fields-bulk-update`: Measure parsing, normalization,
  and storage of UTC date-only cells in one 1,000-record bulk update.
- `record-update/1k-checkbox-fields-bulk-update`: Measure boolean/null cell
  semantics in one 1,000-record bulk update.
- `record-update/1k-single-select-fields-bulk-update`: Measure option lookup and
  single-select serialization in one 1,000-record bulk update.
- `record-update/1k-multiple-select-fields-bulk-update`: Measure array
  validation and multiple-select serialization in one 1,000-record bulk update.
- `record-update/1k-rating-field-bulk-update`: Measure bounded rating validation
  and storage in one 1,000-record bulk update.
- `record-update/1k-primary-text-only-bulk-update`: Establish the narrowest
  1,000-record scalar update baseline: one `Title` field in the table and one
  field in every request record.
- `record-update/1k-wide-table-title-only-bulk-update`: Separate wide-schema
  planning cost from payload width by updating only `Title` in the same 20-field
  fixture used by the aggregate mixed update case.
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
- `record-update/single-foreign-first-name-update-1of40-fanout100-4k`: Measure
  the distinct single-record `updateRecord` route for one normal text-cell edit
  and its propagation through 100 Orders, five formula levels, and 10 Purchase
  aggregates.
- `record-update/single-foreign-select-update-1of40-fanout100-4k`: Measure the
  single-record `updateRecord` route for one option-backed Status edit and its
  propagation through the same 100-Order depth-five computed fanout.
- `record-reorder/10k-move-last-1k-to-front`: Measure block reorder performance
  in a 10,000-row grid by moving the original last 1,000 visible records to the
  front in one operation.
- `record-undo/delete-1k`: Measure undo replay performance after a user deletes
  1,000 mixed-type records through the grid selection delete path.
- `record-redo/delete-1k`: Measure redo replay performance after a user deletes
  1,000 mixed-type records and then undoes that delete.
- `record-paste/1k-primary-only`: Measure the lower-bound grid paste path for
  inserting 1,000 records into an empty primary-only table.
- `record-paste/1k-single-line-text-10fields`: Measure grid paste performance
  for 1,000 records in a fixed-width ten-field single-line text table.
- `record-paste/1k-long-text-10fields`: Measure grid paste performance for 1,000
  records in a ten-field table dominated by long-text payloads.
- `record-paste/1k-number-10fields`: Measure numeric clipboard parsing and grid
  paste insertion for 1,000 records in a fixed-width ten-field table.
- `record-paste/1k-date-10fields`: Measure date parsing and UTC normalization
  while grid-pasting 1,000 records into a fixed-width ten-field table.
- `record-paste/1k-checkbox-10fields`: Measure boolean and blank-cell
  typecasting while grid-pasting 1,000 records into a fixed-width ten-field
  table.
- `record-paste/1k-single-select-10fields`: Measure single-select option
  resolution while grid-pasting 1,000 records into a fixed-width ten-field table.
- `record-paste/1k-multiple-select-10fields`: Measure comma-delimited
  multi-select parsing and option resolution while grid-pasting 1,000 records
  into a ten-field table.
- `record-paste/1k-rating-10fields`: Measure bounded rating typecasting while
  grid-pasting 1,000 records into a fixed-width ten-field table.
- `record-paste/1k-mixed-20fields`: Measure a bounded 1,000-row grid paste
  across the established 20-field mixed scalar schema.
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

The sync reads the existing registry once and writes only materially changed or
missing rows in ordered batches. Each write request is capped at 512 KiB of
serialized JSON to stay well below proxy body limits as the catalog grows.
`Source SHA` and `Synced At` therefore identify the last sync that changed that
row; unchanged rows keep their previous values.
