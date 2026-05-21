# Running perf cases through teable-ee e2e

The first executable path for this repository is intentionally thin:

1. GitHub Actions checks out `teable-perf-lab`.
2. GitHub Actions checks out `teableio/teable-ee` at a selected ref.
3. The workflow injects the perf-lab test package into
   `teable-ee/community/apps/nestjs-backend/test/perf-lab/`.
4. The selected cases run through `@teable/backend-ee` and
   `vitest-e2e-community.config.ts` in a single serial job.

This keeps the auth bootstrap, seed data, and Nest application startup aligned
with the existing `teable-ee` e2e harness.

The workflow starts Postgres/Redis, runs the e2e seed once, then runs every
selected case for every selected engine inside one Vitest process:

- `v1`: sets `FORCE_V2_ALL=false`.
- `v2`: sets `FORCE_V2_ALL=true`.

The `teable-ee` e2e setup sets `V2_COMPUTED_UPDATE_MODE=sync` for deterministic
computed field updates during tests.

## Workflow

Use `.github/workflows/teable-ee-e2e-perf.yml`.

Manual inputs:

- `teable_ee_ref`: branch, tag, or commit SHA from `teableio/teable-ee`.
- `case_filter`: case id such as `smoke/auth-user` or `formula/10k-calc`.
  Use `all` or a comma-separated list to run multiple cases.
- `engine_filter`: comma-separated engine list from `v1,v2`.
- `samples`: measured samples for endpoint-style cases.
- `primary_threshold_ms`: optional override for the case's primary threshold.
  Leave it empty to use the case config default.

Because `teableio/teable-ee` is private, configure a read-only deploy key on
that repository and store the private key in this repository as
`TEABLE_EE_CHECKOUT_SSH_KEY`.

## Case model

The workflow runs `perf-lab.e2e-spec.ts` once. That spec reads
`PERF_LAB_CASE_FILTER` and `PERF_LAB_ENGINE_LIST`, resolves cases in
`registry.ts`, starts one Nest app per engine, and dispatches each case to a
runner in `framework/runners/`. Each case still writes an independent JSON
artifact and summary tagged with `engine`.

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

The serial job writes artifacts into `perf-lab-artifacts/`:

- `<case-id>-<engine>.json`: raw samples/details, aggregate metrics,
  thresholds, and phases, including trace collection manifest details.
- `summary-<case-id>-<engine>.md`: compact GitHub summary for that result.
- `traces/<case-id>-<engine>/manifest.json`: trace refs captured from response
  headers and the list of Jaeger snapshots saved for the run.
- `traces/<case-id>-<engine>/<step>-<trace-id>.json`: raw Jaeger trace snapshots
  for selected requests.

The uploaded artifact name is
`teable-ee-e2e-perf-serial-<run>-<attempt>`, and it contains all selected
case/engine result files.

## Trace collection

The workflow exports traces to the shared Jaeger service documented in
`docs/operations/trace-viewer.md`:

- `OTEL_EXPORTER_OTLP_ENDPOINT=http://136.119.178.56:4318/v1/traces`
- `TRACE_LINK_BASE_URL=http://136.119.178.56:16686`
- `OTEL_EXPORT_RATIO=1.0`

`perf-lab.e2e-spec.ts` preloads the existing `teable-ee` tracing module before
`initApp()` creates the Nest test app. The perf framework then captures
`traceparent` response headers from OpenAPI axios calls, polls Jaeger at
`/api/traces/<traceId>`, and writes the raw JSON snapshots to the artifact
directory.

To verify observability after a run:

1. Open the job summary and check the `Trace Artifact` table.
2. Download the serial artifact and inspect `traces/**/manifest.json`.
3. Confirm `savedTraceCount` is greater than zero and the saved JSON files have
   Jaeger `data` entries.

The Jaeger UI link is durable while the shared service and retention window keep
the trace. The JSON artifact is also uploaded as durable run evidence.

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

Run all registered cases in both V1 and V2:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=all \
  -f engine_filter=v1,v2
```
