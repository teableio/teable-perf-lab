# teable-perf-lab Plan

## 1. Goal

`teable-perf-lab` is an independent performance regression control plane for
Teable v2.

The current MVP uses one execution entrypoint: checkout `teable-ee` in GitHub
Actions and run perf cases through the existing `@teable/backend-ee` e2e mode.
This avoids starting a full Teable image per case and reuses the same seed,
auth bootstrap, Nest app startup, and database migration path that product e2e
tests already trust.

It should cover this workflow:

1. Build or choose a reproducible performance case.
2. Checkout a selected `teable-ee` branch, tag, or commit SHA.
3. Start the existing e2e Postgres/Redis dependencies.
4. Run `teable-ee` migrations and e2e seed.
5. Inject and run the selected perf case as a Vitest e2e spec.
6. Capture HTTP timings, database details, and later traces.
7. Persist every run so historical performance trends are visible.
8. Publish a report for manual validation, daily regression checks, and release
   gates.

The key design principle is that this repo orchestrates performance validation;
it should reuse Teable preview, v2-devtools, k6, Jaeger, and database APIs rather
than reimplementing them.

## 2. Non-goals

- It is not a replacement for unit tests, v2 e2e tests, or correctness CI.
- It is not a generic load testing platform for every Teable API.
- It should not start a new full Teable app image for every case.
- It should not create a second auth bootstrap path outside `teable-ee` e2e
  seed/session initialization.
- GitHub Actions VM timing is good enough for the first smoke gate. Later
  comparison-grade runs can move the target compute elsewhere while keeping the
  same case model.
- It should not store long-lived production credentials or customer data.
- It should not keep large seed data blobs when deterministic generators can
  create the same data.

## 3. Why A Separate Repository

A separate repo is useful because the performance lab has a different lifecycle
from `teable-ee`.

- Cases need product, QA, and backend review without necessarily changing app
  code.
- Run history and trace artifacts should live beyond a single PR or CI run.
- Daily runs should not require touching `teable-ee`.
- The lab will integrate with preview deployments, release candidates, BYODB
  databases, Jaeger, and dashboards. That orchestration would be noisy inside
  the product repo.
- Existing `teable-ee` assets remain the source of truth for app code and
  instrumentation.

For the first milestone, this separation is intentionally narrow: this repo owns
case files and GitHub workflow orchestration, while `teable-ee` owns the runtime
entrypoint.

## 4. Existing Teable Capabilities To Reuse

### teable-ee e2e Harness

The first runner path reuses:

- `@teable/backend-ee` Vitest e2e config:
  `enterprise/backend-ee/vitest-e2e-community.config.ts`
- e2e seed:
  `pnpm -F @teable/db-main-prisma-ee prisma-db-seed -- --e2e`
- seeded user/session:
  `test@e2e.com` / `12345678`
- test app startup:
  `initApp()`
- migration path:
  `make postgres.mode`

Perf cases are copied into
`community/apps/nestjs-backend/test/perf-lab/` at workflow runtime. The workflow
always executes `perf-lab.e2e-spec.ts`; the spec resolves `PERF_LAB_CASE_ID` from
the typed registry and dispatches to the appropriate runner.

### Preview Trace

`teable-ee` preview can expose trace evidence directly from API responses:

- Backend writes `traceparent`.
- Backend writes `Link: <jaeger-url>; rel="trace"` when `TRACE_LINK_BASE_URL`
  is configured.
- Preview template can provision an isolated Jaeger instance and configure
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- PR `tracing` label changes trigger preview update.

The runner should save both response headers and a raw Jaeger trace snapshot for
each measured step.

### v2 Instrumentation

v2 already has span attributes for:

- `teable.version`
- `teable.component`
- `teable.operation`
- `teable.table_id`
- `teable.record_id`
- `teable.field_id`
- `teable.event.*`

The runner should add a small request-level correlation convention:

- `x-teable-perf-run-id`
- `x-teable-perf-case-id`
- `x-teable-perf-step-id`

Then Teable can attach these to spans in the route tracing interceptor. This is
the only product-side enhancement needed for the MVP.

### v2-devtools

Use v2-devtools for local or direct database operations:

- import `.tea` schema
- generate mock records
- inspect computed outbox
- pause/resume/replay computed tasks when needed
- run command explain or database explain paths

The lab should wrap these as tools, not fork their logic.

### k6

k6 is useful as an execution adapter for API workloads:

- scenarios
- virtual users
- checks
- thresholds
- output summary

The lab should not make k6 the case model. The case model should be Teable
domain-specific, and k6 can be one runner backend.

## 5. Repository Layout

Proposed layout:

```text
teable-perf-lab/
  .github/
    workflows/
      teable-ee-e2e-perf.yml
  perf-lab.e2e-spec.ts
  registry.ts
  framework/
    define-perf-case.ts
    run-perf-case.ts
    runners/
      http-endpoint.runner.ts
      formula-table.runner.ts
  cases/
    smoke/
      auth-user.case.ts
    formula/
      10k-calc.case.ts
  packages/
    cli/
    runner/
    case-schema/
    collectors/
    reporters/
    storage/
  docs/
    plan.md
    operations/
      teable-ee-e2e.md
    run-history.md
    case-authoring.md
    operations.md
  scripts/
    bootstrap-target.ts
    collect-jaeger-trace.ts
    compare-baseline.ts
  artifacts/
    .gitkeep
```

`artifacts/` is for local development only. Durable run history should not rely
on committed files.

## 6. Case Model

Each case should define intent, environment needs, setup, measured steps, and
thresholds. The MVP uses TypeScript case configs instead of YAML so field types,
formula expressions, deterministic generators, and verification hooks stay
typed and close to the e2e helpers.

Example:

```ts
export default definePerfCase({
  id: "formula/10k-calc",
  title: "10k rows formula calculation",
  runner: "formula-table",
  config: {
    recordCount: 10_000,
    batchSize: 1_000,
    formula: {
      name: "Total",
      expression: "({A} * {B}) + {C}",
    },
    threshold: {
      metric: "formulaReadyMs",
      maxMs: 60_000,
    },
  },
});
```

`.tea` should be used for schema and view structure. Large records should be
generated by `seed.ts` to keep the case easy to review and update.

## 7. Run Flow

### Prepare

1. Resolve `teable-ee` ref:
   - default branch such as `develop`
   - release tag
   - fixed commit SHA
2. Checkout `teable-perf-lab` and `teable-ee`.
3. Install `teable-ee` dependencies.
4. Start Postgres/Redis through the `teable-ee` e2e dependency path.
5. Create an empty e2e database.
6. Run `make postgres.mode`.
7. Run `pnpm -F @teable/db-main-prisma-ee prisma-db-seed -- --e2e`.
8. Copy the selected case into `teable-ee`.
9. Record target metadata:
   - commit SHA
   - branch or tag
   - Teable edition
   - Node version if exposed
   - Postgres version
   - GitHub runner image

### Warmup

1. Run configured warmup steps.
2. Drain computed tasks.
3. Drop warmup measurements.
4. Verify the case state is ready.

### Measure

1. Execute API steps with correlation headers.
2. Save response status, timing, headers, and body summary.
3. Extract trace headers.
4. Poll or fetch Jaeger raw trace.
5. Collect v2 computed and database state.
6. Repeat if the case requires multiple samples.

### Evaluate

1. Aggregate samples.
2. Compare with absolute thresholds.
3. Compare with selected baseline.
4. Mark run as pass, warn, or fail.
5. Generate report.

### Cleanup

1. Export final debug metadata if configured.
2. Upload workflow artifacts.
3. Remove e2e containers and volumes.
4. Keep run history and trace artifacts.

## 8. History And Trace Persistence

Run history must survive GitHub Actions retention and preview cleanup.

The persisted model should include:

```text
run
  id
  trigger_type: manual | schedule | release | pr
  runner: teable-ee-e2e
  teable_ee_ref
  commit_sha
  started_at
  finished_at
  status

case_run
  run_id
  case_id
  status
  samples
  summary_metrics_json
  threshold_result_json

step_run
  run_id
  case_id
  step_id
  sample_index
  status_code
  duration_ms
  trace_id
  traceparent
  trace_link
  jaeger_snapshot_url
  metrics_json

artifact
  run_id
  case_id
  step_id
  type: jaeger-raw | jaeger-summary | k6-summary | db-snapshot | report
  storage_url
  sha256
  bytes
```

Recommended first implementation:

- Metadata: Postgres table in a dedicated perf-lab database.
- Large artifacts: S3 or R2 object storage.
- Reports: generated Markdown plus JSON summary.

Why not GitHub Actions artifacts only:

- Retention is limited.
- Historical querying is poor.
- Trace snapshots should outlive preview environments.

Why not commit run results to git:

- History will become noisy quickly.
- Large Jaeger JSON artifacts are a bad fit for git.
- Re-running daily jobs should not create repository churn.

## 9. Baseline Policy

Use both absolute and trend-based checks.

### Absolute Gate

Useful for release safety:

- p95 API latency below a hard limit
- computed drain below a hard limit
- no failed computed outbox tasks
- no unexpected 5xx

### Relative Gate

Useful for detecting regressions:

- compare to last known good run on the same case and target class
- compare to rolling median of last N daily runs
- fail on severe regression, warn on moderate regression

Initial policy:

- fail if absolute threshold fails
- fail if regression is greater than 30%
- warn if regression is 15% to 30%
- require at least 3 successful historical runs before relative gate is enforced

## 10. Triggering

### Manual Trigger

Manual trigger should accept:

- `teable-ee` ref
- case filter
- sample count
- whether to refresh baseline

### Daily Trigger

Daily trigger should run the stable case suite against a fixed `teable-ee` ref:

- default branch or nightly release branch
- with e2e Postgres/Redis dependencies
- with optional tracing enabled later
- with run history persisted

### Release Trigger

Release trigger should run the release gate suite against the release candidate
tag or commit SHA.

### PR Trigger

PR trigger should be opt-in, not default on every PR:

- label or comment based
- smaller case suite by default
- post results back to the PR

## 11. GitHub Actions Draft

The first real workflow should support:

- `workflow_dispatch`
- later `schedule`
- later `repository_dispatch` for release automation

The current executable workflow uses the GitHub runner as the e2e runtime and
keeps the execution path inside `teable-ee`. That is acceptable for the first
smoke gate. Later comparison-grade suites can move the target compute while
keeping case authoring and reporting in this repo.

See [docs/examples/perf-regression.workflow.yml](examples/perf-regression.workflow.yml)
for a draft.

## 12. Report Shape

Every run should publish:

- run id
- target
- target commit/image
- case results
- pass/warn/fail
- baseline used
- top regressions
- trace links
- persisted trace artifact links
- computed outbox summary
- top database spans

Example PR or release summary:

```text
teable-perf-lab run 2026-05-20T10-00Z

Target: teable-ee develop@abc1234
Status: FAIL

formula.10k-basic
  http p95: 2.6s, threshold 2.0s
  computed drain: 9.4s, threshold 8.0s
  regression vs rolling median: +31%
  trace: https://...
  trace snapshot: s3://...
```

## 13. MVP Milestones

### Milestone 1: teable-ee e2e Smoke

- repo exists
- executable workflow exists
- first case runs through `@teable/backend-ee`
- e2e seed/session handles auth initialization
- artifacts include raw JSON and GitHub summary

### Milestone 2: Case Shape

- keep cases reviewable in this repo
- add case metadata next to executable e2e specs
- support more case filters without changing the workflow shape
- keep `teable-ee` as the only runtime entrypoint

### Milestone 3: Durable History

- create perf-lab database schema
- persist run/case/step metadata
- persist Jaeger raw trace snapshots to object storage
- query previous runs for a case

### Milestone 4: BYODB Isolation

- provision BYODB database/schema
- create Teable space
- bind space to BYODB
- cleanup reliably

### Milestone 5: First Real Case

- implement `formula.10k-basic`
- seed 10k rows deterministically
- run measured update
- wait for computed drain
- collect trace and outbox details
- compare to thresholds

### Milestone 6: Automation

- manual GitHub Actions trigger
- daily scheduled trigger
- release dispatch trigger
- report to GitHub summary and optional PR comment

### Milestone 7: Trend Dashboard

- expose run history as SQL views or a small dashboard
- graph key metrics by case over time
- link trend points to trace snapshots

## 14. Product-Side Small Change Request

Add perf correlation headers to route spans in `teable-ee`:

```text
x-teable-perf-run-id
x-teable-perf-case-id
x-teable-perf-step-id
```

These should become span attributes:

```text
teable.perf.run_id
teable.perf.case_id
teable.perf.step_id
```

This keeps trace discovery robust even if a runner report is partially missing.

## 15. Open Questions For Review

1. Should the first durable metadata store be a dedicated Postgres database or a
   Teable base?
2. Should large artifacts go to S3, Cloudflare R2, or existing Teable object
   storage?
3. Which `teable-ee` ref should daily runs use: `develop`, nightly tag, or
   release candidate SHA?
4. Should failed runs keep e2e DB dumps for manual debugging, or only keep
   snapshots and traces?
5. Should baseline approval be automatic after a successful release, or manual?
6. Should k6 be mandatory for all API workloads or only used when concurrency is
   needed?
7. Which case should be first: formula 10k, lookup fanout, rollup chain, or field
   conversion?
