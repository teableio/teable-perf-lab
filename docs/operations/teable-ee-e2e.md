# Running perf cases through teable-ee e2e

The first executable path for this repository is intentionally thin:

1. GitHub Actions checks out `teable-perf-lab`.
2. GitHub Actions checks out `teableio/teable-ee` at a selected ref.
3. The workflow injects one perf case into
   `teable-ee/community/apps/nestjs-backend/test/perf-lab/`.
4. The case runs through `@teable/backend-ee` and
   `vitest-e2e-community.config.ts`.

This keeps the auth bootstrap, seed data, and Nest application startup aligned
with the existing `teable-ee` e2e harness.

## Workflow

Use `.github/workflows/teable-ee-e2e-perf.yml`.

Manual inputs:

- `teable_ee_ref`: branch, tag, or commit SHA from `teableio/teable-ee`.
- `case_filter`: currently `smoke/auth-user`.
- `samples`: measured samples for the case.
- `perf_threshold_p95_ms`: p95 threshold for the smoke case.

If `teableio/teable-ee` is private, configure a repository secret named
`TEABLE_EE_CHECKOUT_TOKEN` with read access to that repository.

## First case

`cases/smoke/auth-user.e2e-spec.ts` measures authenticated
`GET /api/auth/user/me`.

It relies on the existing e2e seed user from `teable-ee`:

- id: `usrTestUserId`
- email: `test@e2e.com`
- password: `12345678`

The case does not register users or create a separate auth setup path. It calls
`initApp()`, which starts the Nest app, signs in the seeded user, and installs
the session cookie on the shared OpenAPI axios instance.

## Artifacts

The workflow writes artifacts into `perf-lab-artifacts/`:

- `auth-user.json`: raw samples and aggregate metrics.
- `summary.md`: a compact GitHub job summary.
