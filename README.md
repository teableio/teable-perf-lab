# teable-perf-lab

Performance regression lab for Teable v2.

The current MVP runs perf cases through the existing `teable-ee` e2e harness,
reusing its Postgres/Redis, seed, and Nest app startup. V1 and V2 are measured
separately but share that setup. The execution mechanics (how the workflow
checks out `teable-ee`, injects the framework, and runs cases serially) live in
[docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md).

This repository is intended to become the control plane for Teable performance
regression validation:

- define reproducible performance cases as typed case configs
- run API-level end-to-end workloads through the `teable-ee` e2e entrypoint
- persist run history, metrics, artifacts, and trace snapshots
- publish manual and scheduled regression reports

The executable entrypoint is `perf-lab.e2e-spec.ts`. Case definitions live under
`cases/**/*.case.ts`, and each case must have a same-name `cases/**/*.md`
description beside it. Shared runners and artifacts live in `framework/`. Cases
are registered in `registry.ts`.

## Adding A Case

The case authoring workflow lives in the agent playbook at
[.agent/README.md](.agent/README.md). It walks through intake, drafting a case
spec, choosing a runner, writing the files, registering, and validating. Start
there whether you are a person or an agent adding a case. The broader design is
in [docs/plan.md](docs/plan.md); operational details are in
[docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md).

## Available Cases

- `smoke/auth-user`: authenticated `GET /api/auth/user/me` smoke timing.
- `formula/10k-calc`: create 10k rows, add a formula field, and verify computed
  values are ready.
- `formula/10k-5-concurrent`: create 10k rows once, concurrently add 5 formula
  fields on the same table, and verify computed values are ready.
- `lookup/conditional-10k`: create two 10k-row tables with permuted unique keys,
  add a conditional lookup on the host table, and verify each sampled row
  returns a different source value.
- `selection-clear/flat-10k-20fields-cell-clear-stream`: create a 10k-row
  mixed-field table, clear all visible cells through
  `PATCH /selection/clear-stream`, and verify the rows remain with empty cells.
- `record-delete/delete-10k`: create a 10k-row mixed-field table, delete all rows
  through `GET /selection/delete-stream`, and verify the table is empty.
- `record-undo/delete-10k`: create a 10k-row mixed-field table, delete all
  rows before measurement, replay undo, and verify sample rows are restored.
- `record-redo/delete-10k`: create a 10k-row mixed-field table, delete and
  undo before measurement, replay redo, and verify the table is empty.
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
