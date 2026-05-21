# teable-perf-lab

Performance regression lab for Teable v2.

The current MVP runs perf cases through the existing `teable-ee` e2e harness.
This keeps setup lightweight: GitHub Actions checks out `teable-ee`, injects the
perf case framework, starts the same e2e Postgres/Redis services, runs the
existing seed, and executes the selected cases with `@teable/backend-ee` in one
serial job. V1 and V2 are still measured separately, but they share the same
runner checkout, dependency install, database, Redis, and e2e seed setup.

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

Available cases:

- `smoke/auth-user`: authenticated `GET /api/auth/user/me` smoke timing.
- `formula/10k-calc`: create 10k rows, add a formula field, and verify computed
  values are ready.
- `formula/10k-5-concurrent`: create 10k rows once, concurrently add 5 formula
  fields on the same table, and verify computed values are ready.
- `lookup/conditional-10k`: create two 10k-row tables with permuted unique keys,
  add a conditional lookup on the host table, and verify each sampled row
  returns a different source value.

For operational details, see
[docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md). The broader
design remains in [docs/plan.md](docs/plan.md).

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
