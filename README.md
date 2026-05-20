# teable-perf-lab

Performance regression lab for Teable v2.

The current MVP runs perf cases through the existing `teable-ee` e2e harness.
This keeps setup lightweight: GitHub Actions checks out `teable-ee`, injects a
case spec, starts the same e2e Postgres/Redis services, runs the existing seed,
and executes one selected spec with `@teable/backend-ee`.

This repository is intended to become the control plane for Teable performance
regression validation:

- define reproducible performance cases as code
- run API-level end-to-end workloads through the `teable-ee` e2e entrypoint
- persist run history, metrics, artifacts, and trace snapshots
- publish manual and scheduled regression reports

The first executable case is `cases/smoke/auth-user.e2e-spec.ts`; it is wired by
`.github/workflows/teable-ee-e2e-perf.yml`.

For operational details, see
[docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md). The broader
design remains in [docs/plan.md](docs/plan.md).
