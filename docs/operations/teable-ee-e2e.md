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

The workflow starts Postgres/Redis, restores a cached perf seed database dump
when one is available, otherwise runs migrations plus the normal e2e seed, then
runs every selected case for every selected engine inside one Vitest process:

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

The runner catalog is in [.agent/runners.md](../../.agent/runners.md). The list
of registered cases is in the `README.md` "Available Cases" section. To add or
change a case, follow the playbook in [.agent/README.md](../../.agent/README.md);
the workflow does not need a case-specific branch.

## Auth and seed

It relies on the existing e2e seed user from `teable-ee`:

- id: `usrTestUserId`
- email: `test@e2e.com`
- password: `12345678`

The case does not register users or create a separate auth setup path. It calls
`initApp()`, which starts the Nest app, signs in the seeded user, and installs
the session cookie on the shared OpenAPI axios instance.

## Seed Cache

The workflow exports `PERF_LAB_SEED_CACHE_ENABLED=true`. Before the Nest app is
started, it tries to restore `perf-lab-seed-cache/e2e_test_teable.dump` from
GitHub Actions cache and load it with `pg_restore`. If that fails or no dump is
available, it creates a clean e2e database from migrations and the standard
`prisma-db-seed -- --e2e` path.

After a successful perf run, the job saves a new `pg_dump -Fc` snapshot. That
snapshot can contain reusable seed tables from previous cache-aware cases.
Runner-level `seedHash` names decide whether a table is valid for a specific
case; stale tables in the dump are ignored unless the hash matches and
`seedReady` validation passes.

Formula, conditional lookup, record delete, record undo, record redo, and
selection clear cases currently use this cache. Formula and lookup cases keep
source fixture tables between runs and delete only execute-time formula or
lookup fields in cleanup. Record delete/undo/redo restore reusable fixtures to a
seed-ready state after the measured operation; selection clear writes the
deterministic cell values back during cleanup. Paste cases intentionally do not
skip the 10k paste workload because that import is the measured execute step.
When a case reports `skipped`, the workflow still succeeds and writes artifacts;
this is reserved for engine-specific capability gaps. Prefer reshaping a case to
the same V1/V2 user action, such as the 1k record mutation cases, before adding
a skip.

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

The workflow exports traces to the shared Jaeger service. Its endpoints and the
`OTEL_*` / `TRACE_LINK_BASE_URL` values are defined once in
[trace-viewer.md](trace-viewer.md) and set in the workflow env; do not restate
the endpoint URLs here.

`perf-lab.e2e-spec.ts` preloads the existing `teable-ee` tracing module before
`initApp()` creates the Nest test app. The perf framework captures `traceparent`
response headers from OpenAPI axios calls and from raw SSE/fetch stream
requests that use the perf SSE helper. It then polls Jaeger at
`/api/traces/<traceId>` and writes the raw JSON snapshots to the artifact
directory. Stream artifacts should also include the response routing headers,
such as `x-teable-v2`, so V1 legacy streams and V2 streams can be distinguished
even when they share the same HTTP endpoint.

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
