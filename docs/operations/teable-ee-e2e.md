# Running perf cases through teable-ee e2e

The first executable path for this repository is intentionally thin:

1. GitHub Actions checks out `teable-perf-lab`.
2. GitHub Actions checks out `teableio/teable-ee` at a selected ref.
3. The workflow injects the `cases/` framework into
   `teable-ee/community/apps/nestjs-backend/test/perf-lab/`.
4. The selected case runs through `@teable/backend-ee` and
   `vitest-e2e-community.config.ts`.

This keeps the auth bootstrap, seed data, and Nest application startup aligned
with the existing `teable-ee` e2e harness.

## Workflow

Use `.github/workflows/teable-ee-e2e-perf.yml`.

Manual inputs:

- `teable_ee_ref`: branch, tag, or commit SHA from `teableio/teable-ee`.
- `case_filter`: case id such as `smoke/auth-user` or `formula/10k-calc`.
- `samples`: measured samples for endpoint-style cases.
- `primary_threshold_ms`: optional override for the case's primary threshold.
  Leave it empty to use the case config default.

Because `teableio/teable-ee` is private, configure a read-only deploy key on
that repository and store the private key in this repository as
`TEABLE_EE_CHECKOUT_SSH_KEY`.

## Case model

The workflow always runs `cases/perf-lab.e2e-spec.ts`. That spec reads
`PERF_LAB_CASE_ID`, resolves the case in `cases/registry.ts`, and dispatches to a
runner in `cases/framework/runners/`.

Current runners:

- `http-endpoint`: warm up an authenticated endpoint and collect sample
  durations.
- `formula-table`: create a temporary table, seed deterministic records, create
  a formula field, verify computed values, then clean up.

Current cases:

- `smoke/auth-user`: measures authenticated `GET /api/auth/user/me`.
- `formula/10k-calc`: creates 10k deterministic rows and measures
  `formulaReadyMs`, which includes formula field creation plus sample reads that
  prove computed values are available.

To add a case, add a `*.case.ts` config and register it in `cases/registry.ts`.
Only add a new runner when the setup or measurement behavior is genuinely new.
The workflow should not need a case-specific branch.

## Auth and seed

It relies on the existing e2e seed user from `teable-ee`:

- id: `usrTestUserId`
- email: `test@e2e.com`
- password: `12345678`

The case does not register users or create a separate auth setup path. It calls
`initApp()`, which starts the Nest app, signs in the seeded user, and installs
the session cookie on the shared OpenAPI axios instance.

## Artifacts

The workflow writes artifacts into `perf-lab-artifacts/`:

- `<case-id>.json`: raw samples/details, aggregate metrics, thresholds, and
  phases.
- `summary.md`: a compact GitHub job summary.

## Manual examples

Run smoke:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=smoke/auth-user \
  -f samples=10
```

Run the 10k formula case using its default threshold:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=formula/10k-calc
```
