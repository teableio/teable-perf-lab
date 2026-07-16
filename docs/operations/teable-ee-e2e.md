# Running perf cases through teable-ee e2e

The executable path for this repository is intentionally aligned with the
existing `teable-ee` e2e harness:

1. GitHub Actions checks out `teable-perf-lab`.
2. GitHub Actions checks out `teableio/teable-ee` at a selected ref.
3. The workflow injects the perf-lab test package into
   `teable-ee/community/apps/nestjs-backend/test/perf-lab/`.
4. A seed job prepares a reusable Postgres dump for the selected cases.
5. V1 and V2 execute jobs restore that same dump into separate Postgres
   containers and run in parallel through `@teable/backend-ee`.

This keeps the auth bootstrap, seed data, and Nest application startup aligned
with the existing `teable-ee` e2e harness.

The workflow starts Postgres/Redis in each job. The seed job restores a cached
perf seed database dump when one is available, otherwise runs migrations plus
the normal e2e seed, then runs `PERF_LAB_MODE=seed` with `FORCE_V2_ALL=false` to
make all selected case-specific source tables ready. The execute jobs restore
the seed job's DB dump artifact and run the selected cases with:

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
- `computed_update_mode`: optional V2 computed update mode for the execute jobs
  (`sync` | `hybrid`). Leave empty to keep the e2e default (`sync`). The e2e
  setup forces `sync` for deterministic computed values; pass `hybrid` to instead
  exercise the production outbox + polling-worker path (`HybridWithOutboxStrategy`)
  so a case can measure the real async propagation window after a write. Only run
  async-tolerant cases (those that poll until computed values settle, e.g.
  `lookup/dual-link-computed-*`) with `hybrid`, because the mode is per execute
  job and applies to every selected case in that run. The perf spec applies it
  after the e2e setup and before `initApp()` builds the V2 container.
  When `case_filter=all` and this input is empty, the workflow automatically
  splits V2 execution: all normal cases run with the default sync mode, while
  the four registered `lookup/dual-link-computed-*` cases (bulk first-link,
  single-record `getRecord`, single-record filtered `getRecords`, and bulk
  repoint) run in a separate V2 hybrid job. Passing an explicit
  `computed_update_mode` disables that automatic split and applies the requested
  mode to every selected V2 case in the run.
  Because `teableio/teable-ee` is private, configure a read-only deploy key on
  that repository and store the private key in this repository as
  `TEABLE_EE_CHECKOUT_SSH_KEY`.

## Case model

The seed job runs `perf-lab.e2e-spec.ts` with `PERF_LAB_MODE=seed`. That mode
resolves cases in `registry.ts`, starts one legacy-compatible Nest app, and
dispatches only each runner's seed preparation path. It does not create the
measured formula, lookup, delete, undo, redo, or clear operation.

Each execute job runs `perf-lab.e2e-spec.ts` with `PERF_LAB_MODE=execute` and a
single `PERF_LAB_ENGINE_LIST` value. It starts one Nest app for that engine and
dispatches each case to a runner in `framework/runners/`. Each case writes an
independent JSON artifact and summary tagged with `engine`.

The runner catalog is in [.agents/runners.md](../../.agents/runners.md). The list
of registered cases is in the `README.md` "Available Cases" section. To add or
change a case, follow the playbook in [.agents/README.md](../../.agents/README.md);
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

The workflow exports `PERF_LAB_SEED_CACHE_ENABLED=true`. The seed DB cache key
is based on runner OS, normalized case filter, Teable Prisma schema/migration
hash, and perf-lab case/framework source hash. It does not include the target
`teable-ee` commit SHA. Ordinary backend code changes can therefore reuse the
same seed dump; Prisma schema/migration changes or seed code changes force a new
dump.

The schema hash is computed from:

```text
teable-ee/packages/db-main-prisma/prisma/postgres/schema.prisma
teable-ee/packages/db-main-prisma/prisma/postgres/migrations/**
teable-ee/community/packages/db-data-prisma/prisma/schema.prisma
teable-ee/community/packages/db-data-prisma/prisma/migrations/**
```

On an exact cache hit, the seed job only checks that
`perf-lab-seed-cache/e2e_test_teable.dump` exists. It skips dependency install,
service startup, seed mode, and seed validation. On a cache miss or restore-key
hit, the seed job starts services, restores any available dump with `pg_restore`
when possible, otherwise rebuilds from migrations and `prisma-db-seed -- --e2e`,
then runs `PERF_LAB_MODE=seed`. Cache-aware runners validate existing
hash-derived seed tables or build missing/stale fixtures. A successful seed job
saves a new exact-key `pg_dump -Fc` snapshot.

The seed job uploads the selected dump as a same-run artifact, and execute jobs
download that artifact into isolated V1/V2 databases before running the measured
cases. Runner-level `seedHash` names decide whether a table is valid for a
specific case; stale tables in the dump are ignored unless the hash matches and
`seedReady` validation passes.

Formula, conditional lookup, CSV import, record delete, record undo, record
redo, and selection clear cases currently use this cache. CSV import caches the
empty target table shape and best-effort import attachment metadata; the import
itself still runs fresh in execute. Because each execute job restores the seed
dump into an isolated database, destructive cases can mutate their seed tables
during execution without affecting the other engine or the next workflow run.
Paste cases intentionally do not skip the 10k paste workload because that import
is the measured execute step.
When a case reports `skipped`, the workflow still succeeds and writes artifacts;
this is reserved for engine-specific capability gaps. Prefer reshaping a case to
the same V1/V2 user action, such as the 1k record mutation cases, before adding
a skip.

## Artifacts

The seed job uploads `teable-ee-e2e-perf-seed-<run>-<attempt>` and
`teable-ee-e2e-perf-seed-db-<run>-<attempt>`. The execute jobs upload two
artifacts per engine: a lightweight results artifact for normal checks and a
full artifact for raw Jaeger trace debugging.

Lightweight results artifacts (default for the report job and routine
downloads):

- `teable-ee-e2e-perf-results-v1-<run>-<attempt>`
- `teable-ee-e2e-perf-results-v2-<run>-<attempt>`

Each results artifact contains only the small files the report and Feishu
scripts consume:

- `<case-id>-<engine>.json`: raw samples/details, aggregate metrics,
  thresholds, and phases, including trace collection manifest details.
- `summary-<case-id>-<engine>.md`: compact GitHub summary for that result.
- `traces/<case-id>-<engine>/manifest.json`: trace refs captured from response
  headers and the list of Jaeger snapshots saved for the run.

Full artifacts (kept for deep debugging and to preserve old links):

- `teable-ee-e2e-perf-v1-<run>-<attempt>`
- `teable-ee-e2e-perf-v2-<run>-<attempt>`

Each full artifact contains everything in the results artifact plus the heavy
raw Jaeger snapshots:

- `traces/<case-id>-<engine>/<step>-<trace-id>.json`: raw Jaeger trace snapshots
  for selected requests. Download the full artifact only when you need to
  inspect these raw snapshots; the results artifact is enough for metrics,
  summaries, and manifest counts.

The report job resolves the lightweight `teable-ee-e2e-perf-results-v*`
artifacts by default and falls back to the full `teable-ee-e2e-perf-v*`
artifacts when no results artifact exists for the run (for example, when
re-running report on an older run). It downloads the resolved artifacts, merges
their JSON payloads, and upserts the result rows to Teable.

For the exact JSON field shapes of each file (payload, manifest, and raw
snapshot) plus a "what to read for X" cheat sheet, see
[../../.agents/artifact-content.md](../../.agents/artifact-content.md).

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
directory. During each case, the runner can call the Teable OpenTelemetry SDK's
force flush periodically with `PERF_LAB_TRACE_BACKGROUND_FLUSH_MS`; this keeps
large cases from holding all spans in the batch processor until the end. Before
polling, the runner also asks the SDK to flush pending spans one final time, then
waits `PERF_LAB_TRACE_FETCH_SETTLE_MS` so the OTEL exporter and Jaeger query path
have a short settle window. The workflow saves up to
`PERF_LAB_TRACE_MAX_SNAPSHOTS` sampled raw JSON traces per case and fetches them
with `PERF_LAB_TRACE_FETCH_CONCURRENCY` workers. Cases that generate many
same-shape request traces may set `PERF_LAB_TRACE_INCLUDE_STEP_PATTERN` in their
case runtime env to save representative raw snapshots instead of requiring every
request trace to survive Jaeger ingestion. If a selected representative trace is
sampled but cannot be fetched from Jaeger, cases may set
`PERF_LAB_TRACE_FALLBACK_STEP_PATTERN` to try a bounded number of same-shape
sampled fallback refs before recording a failed fetch. Refs with an unsampled
`traceparent` are kept in the manifest but skipped for Jaeger fetch because
those traces are not expected to be stored. Sampled refs above the snapshot cap,
outside a case's include pattern, replaced by a saved fallback trace, or covered
by an already saved same-shape trace are also recorded as skipped so the manifest
explains any intentional `traceRefCount > savedTraceCount` gap. Stream artifacts
should also include the response routing headers, such as `x-teable-v2`, so V1
legacy streams and V2 streams can be distinguished even when they share the same
HTTP endpoint.

To verify observability after a run:

1. Open the job summary and check the `Trace Artifact` table.
2. Download the V1 or V2 results artifact and inspect
   `traces/**/manifest.json` for `savedTraceCount` and the saved-trace list.
3. To confirm the saved snapshots themselves have Jaeger `data` entries,
   download the full `teable-ee-e2e-perf-v*` artifact, which carries the raw
   `traces/<case-id>-<engine>/<step>-<trace-id>.json` files.

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
