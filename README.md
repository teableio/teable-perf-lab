# teable-perf-lab

Agent-facing context for Teable performance regression cases. Treat this file as
the project map, not a product overview.

This repo defines reproducible perf cases and runs them through the existing
`teable-ee` e2e harness. GitHub Actions checks out `teable-ee`, injects this
repo, prepares a reusable seed database dump, and restores that dump into
isolated V1/V2 execute jobs. The measured operation runs after seed data is
ready.

## Read Order

- Adding or changing a case: read [.agent/README.md](.agent/README.md) next and
  draft the case spec before coding.
- Changing seed/cache behavior: read
  [.agent/seed-execute.md](.agent/seed-execute.md).
- Adding a runner: read [.agent/runners.md](.agent/runners.md), then
  [.agent/new-runner-contract.md](.agent/new-runner-contract.md) only if reuse or
  extension cannot express the case.
- Running the GitHub workflow: read
  [docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md). That file
  owns trigger commands and workflow inputs.

## File Map

- `perf-lab.e2e-spec.ts`: executable e2e entrypoint copied into `teable-ee`.
- `registry.ts`: registered runnable cases and manual aliases.
- `cases/**/*.case.ts`: typed case configs.
- `cases/**/*.md`: same-name case descriptions used by registry sync.
- `framework/runners/*.runner.ts`: runner implementations.
- `framework/types.ts`: runner kinds, case config interfaces, result types.
- `framework/seed-cache.ts`: runner-level seed hash helpers.
- `.github/workflows/teable-ee-e2e-perf.yml`: seed job, execute jobs, artifacts,
  report, and Teable registry sync.
- `.agent/*.md`: agent workflow and implementation rules.

## Hard Rules

- Keep changes inside this repo unless the user explicitly asks otherwise.
- Do not edit `../teable-ee` for perf-lab case implementation.
- Every runnable case needs `cases/<group>/<name>.case.ts`, same-name `.md`, and
  a `registry.ts` entry.
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
- Execute jobs restore the exact-key dump into separate V1/V2 Postgres
  containers, set the target engine, and run measured operations. Cache-aware
  runners run `seedReady`/`sourceReady` again before execute. Destructive cases
  may mutate their isolated execute database.

Current cache-aware runners:

- `formula-table`
- `conditional-lookup`
- `csv-import`
- `record-create`
- `record-update`
- `record-reorder`
- `record-delete`
- `record-undo`
- `record-redo`
- `selection-clear`
- `lookup-search-index`

Paste cases intentionally keep the 10k inserted rows in the execute stage
because the paste import is the measured operation. Their reusable seed is only
an empty table shape, so caching it would not remove the expensive measured
workload.

## Available Cases

- `smoke/auth-user`: authenticated `GET /api/auth/user/me` smoke timing.
- `formula/10k-calc`: create 10k rows, add a formula field, and verify computed
  values are ready.
- `formula/10k-5-concurrent`: create 10k rows once, concurrently add 5 formula
  fields on the same table, and verify computed values are ready.
- `lookup/conditional-10k`: create two 10k-row tables with permuted unique keys,
  add a conditional lookup on the host table, and verify each sampled row
  returns a different source value.
- `search/search-index-off-10k-20search-fields`: create source and host 10k-row
  lookup-search tables, then measure global `aggregation/search-index` requests
  on the host whose `TableIndex.search` is disabled.
- `search/search-index-on-10k-20search-fields`: reuse the same deterministic
  lookup-search fixture, then measure global `aggregation/search-index`
  requests on the host whose `TableIndex.search` is enabled.
- `csv-import/mixed-10k-20fields-inplace-import`: create an empty 20-field
  mixed-type table, import 10k deterministic CSV rows through
  `PATCH /api/import/{baseId}/{tableId}`, and verify the typed inserted
  records.
- `record-create/mixed-1k-20fields-bulk-create`: create 1k typed records in an
  empty 20-field mixed table through `POST /api/table/{tableId}/record`, then
  verify row count.
- `record-update/mixed-1k-20fields-bulk-update`: update 1k existing records
  across 20 mixed fields through `PATCH /api/table/{tableId}/record`, then
  verify sampled typed records.
- `record-reorder/10k-move-last-1k-to-front`: move the original last 1k records
  to the front of a 10k-row mixed table through the record reorder API, then
  verify sampled view positions.
- `selection-clear/flat-1k-20fields-cell-clear-stream`: create a 1k-row
  mixed-field table, clear all visible cells through
  `PATCH /selection/clear-stream`, and verify the rows remain with empty cells.
- `record-delete/delete-1k`: create a 1k-row mixed-field table, delete all rows
  through `DELETE /selection/delete`, and verify the table is empty.
- `record-undo/delete-1k`: create a 1k-row mixed-field table, delete all rows
  before measurement, replay undo, and verify the row count is restored.
- `record-redo/delete-1k`: create a 1k-row mixed-field table, delete and undo
  before measurement, replay redo, and verify the table is empty.
- `record-paste/flat-10k-4fields-copy-paste`: create an empty 4-field table,
  paste 10k deterministic rows through `PATCH /selection/paste`, and verify the
  inserted records.
- `record-paste/flat-10k-20fields-copy-paste`: create an empty 20-field table,
  paste 10k deterministic rows through `PATCH /selection/paste`, and verify the
  inserted records.
- `record-paste/mixed-10k-20fields-complex-copy-paste`: create an empty
  20-field mixed-type table, paste 10k deterministic rows through
  `PATCH /selection/paste`, and verify the typed inserted records.

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
