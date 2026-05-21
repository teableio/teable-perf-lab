# Running perf cases through teable-ee e2e

The first executable path for this repository is intentionally thin:

1. GitHub Actions checks out `teable-perf-lab`.
2. GitHub Actions checks out `teableio/teable-ee` at a selected ref.
3. The workflow injects the perf-lab test package into
   `teable-ee/community/apps/nestjs-backend/test/perf-lab/`.
4. The selected case runs through `@teable/backend-ee` and
   `vitest-e2e-community.config.ts` in parallel V1 and V2 jobs.

This keeps the auth bootstrap, seed data, and Nest application startup aligned
with the existing `teable-ee` e2e harness.

The workflow uses a two-entry matrix for every selected case:

- `v1`: sets `FORCE_V2_ALL=false`.
- `v2`: sets `FORCE_V2_ALL=true`.

The `teable-ee` e2e setup sets `V2_COMPUTED_UPDATE_MODE=sync` for deterministic
computed field updates during tests.

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

Each matrix job runs `perf-lab.e2e-spec.ts`. That spec reads
`PERF_LAB_CASE_ID`, resolves the case in `registry.ts`, and dispatches to a
runner in `framework/runners/`. The workflow also sets `PERF_LAB_ENGINE` to
`v1` or `v2`; this value is written into the JSON artifact and summary.

Current runners:

- `http-endpoint`: warm up an authenticated endpoint and collect sample
  durations.
- `formula-table`: create a temporary table, seed deterministic records, create
  a formula field, verify computed values, then clean up.
- `conditional-lookup`: create two temporary tables, seed deterministic records,
  create a conditional lookup field, verify sample values, then clean up.

Current cases:

- `smoke/auth-user`: measures authenticated `GET /api/auth/user/me`.
- `formula/10k-calc`: creates 10k deterministic rows and measures
  `formulaReadyMs`, which includes formula field creation plus sample reads that
  prove computed values are available.
- `formula/10k-5-concurrent`: creates 10k deterministic rows once and measures
  five formula fields created concurrently on one table.
- `lookup/conditional-10k`: creates two 10k deterministic tables with permuted
  unique keys and measures conditional lookup readiness.

To add a case, add a `*.case.ts` config under `cases/` and register it in
`registry.ts`.
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

Each matrix job writes artifacts into `perf-lab-artifacts/`:

- `<case-id>.json`: raw samples/details, aggregate metrics, thresholds, and
  phases, including the `engine` field and trace collection manifest details.
- `summary.md`: a compact GitHub job summary for that matrix job.
- `summary-v1.md` or `summary-v2.md`: engine-specific summary for downloaded
  artifacts.
- `traces/<case-id>-<engine>/manifest.json`: trace refs captured from response
  headers and the list of Jaeger snapshots saved for the run.
- `traces/<case-id>-<engine>/<step>-<trace-id>.json`: raw Jaeger trace snapshots
  for selected requests.

The uploaded artifact names include the engine, for example
`teable-ee-e2e-perf-lookup-conditional-10k-v1-<run>-<attempt>` and
`teable-ee-e2e-perf-lookup-conditional-10k-v2-<run>-<attempt>`.

## Trace collection

The workflow starts a local Jaeger container in each matrix job and points the
e2e backend at it with:

- `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces`
- `TRACE_LINK_BASE_URL=http://127.0.0.1:16686`
- `OTEL_EXPORT_RATIO=1.0`

`perf-lab.e2e-spec.ts` preloads the existing `teable-ee` tracing module before
`initApp()` creates the Nest test app. The perf framework then captures
`traceparent` response headers from OpenAPI axios calls, polls Jaeger at
`/api/traces/<traceId>`, and writes the raw JSON snapshots to the artifact
directory.

To verify observability after a run:

1. Open the job summary and check the `Trace Artifact` table.
2. Download the matrix artifact and inspect `traces/**/manifest.json`.
3. Confirm `savedTraceCount` is greater than zero and the saved JSON files have
   Jaeger `data` entries.

The Jaeger UI link is only valid while the GitHub runner job is alive. The JSON
artifact is the durable evidence.

## Manual examples

Run smoke in both V1 and V2:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=smoke/auth-user \
  -f samples=10
```

Run the 10k formula case in both V1 and V2 using its default threshold:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=formula/10k-calc
```
