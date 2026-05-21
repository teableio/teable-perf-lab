# teable-perf-lab

Performance regression lab for Teable v2.

The current MVP runs perf cases through the existing `teable-ee` e2e harness.
This keeps setup lightweight: GitHub Actions checks out `teable-ee`, injects the
perf case framework, starts the same e2e Postgres/Redis services, runs the
existing seed, and executes one selected case with `@teable/backend-ee` in
parallel V1 and V2 jobs.

This repository is intended to become the control plane for Teable performance
regression validation:

- define reproducible performance cases as typed case configs
- run API-level end-to-end workloads through the `teable-ee` e2e entrypoint
- persist run history, metrics, artifacts, and trace snapshots
- publish manual and scheduled regression reports

The executable entrypoint is `perf-lab.e2e-spec.ts`. Case definitions live under
`cases/**/*.case.ts`, while shared runners and artifacts live in `framework/`.
Cases are registered in `registry.ts`.

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
