# Headless benchmark harness

This directory owns the v2 headless benchmark package and its CI tools. The
product checkout stays in `teable-ee`; the harness is mounted into that checkout
only for the duration of a run. Private source, compiled runtime files, logs,
and raw receipts must never be committed to or uploaded from this repository.

## Layout

- `package/` is the complete `@teable/v2-headless-bench` workspace package.
- `scripts/prepare-workspace.mjs` verifies both repositories, mounts the package
  at the source workspace path, applies the pinned lockfile overlay, and writes
  `.headless-bench-source.json` in the source root.
- `scripts/bench-runtime-archive.mjs` creates and restores the private compiled
  runtime. Archive manifests bind both the source and harness SHAs.
- `scripts/benchmark-unified-report.mjs` validates all family receipts and
  renders the single gate report.

The preparation step makes ephemeral tracked lockfile changes in the disposable
source checkout so the mounted benchmark package participates in the pinned
workspace install. It does not change source Core bytes; it resolves the
repository-specific package location itself and keeps the source checkout's
package manager and both source lockfiles authoritative.

## Local run

Use clean checkouts and exact commits. The following commands derive the SHAs
from those checkouts rather than accepting a branch that can move:

```bash
SOURCE_ROOT=/absolute/path/to/teable-ee
HARNESS_ROOT=$(git rev-parse --show-toplevel)
SOURCE_SHA=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
HARNESS_SHA=$(git -C "$HARNESS_ROOT" rev-parse HEAD)

cd "$HARNESS_ROOT"
corepack enable
corepack prepare pnpm@9.13.0 --activate
pnpm install --frozen-lockfile
node headless/scripts/prepare-workspace.mjs \
  --source-root "$SOURCE_ROOT" \
  --source-repository teableio/teable-ee \
  --source-sha "$SOURCE_SHA" \
  --harness-sha "$HARNESS_SHA"

SOURCE_PACKAGE_MANAGER=$(node -p "require('$SOURCE_ROOT/package.json').packageManager")
corepack prepare "$SOURCE_PACKAGE_MANAGER" --activate
cd "$SOURCE_ROOT"
pnpm install --frozen-lockfile --filter @teable/v2-headless-bench...
pnpm -r --filter @teable/v2-headless-bench... build

PRISMA_DATABASE_URL=postgres://postgres@127.0.0.1:5432/teable_bench \
TEABLE_BENCH_OUT_DIR=/tmp/teable-headless-bench \
TEABLE_BENCH_SAMPLES=100 \
TEABLE_BENCH_FAMILIES=storage-query \
pnpm --filter @teable/v2-headless-bench bench:ci
```

A local PostgreSQL 16 database named `teable_bench` is required for that
example. Use `bench:http-ci` for `headless-http`, `bench:core-ci` with
`TEABLE_BENCH_TRACK` for a `core-*` family, and `bench:complexity-ci gate` with
the checked-in complexity calibration for `complexity-score`. CI is the
canonical all-family gate.

`prepare-workspace.mjs` writes source and harness revisions plus lockfile
digests to `.headless-bench-source.json` at the source checkout root. Preserve
that file with any local receipt used for comparison.

## GitHub Actions

`.github/workflows/headless-bench.yml` supports both `workflow_call` and
`workflow_dispatch`. Every run requires immutable `source_sha` and
`harness_sha` inputs. `source_repository` defaults to `teableio/teable-ee`.
Optional `pr_number`, `log_tag`, and `check_run_id` values carry the EE Remote
CI context.

A direct run from a checked-out harness branch, in a repository where the RCI
App credentials are configured, can be dispatched with:

```bash
SOURCE_ROOT=/absolute/path/to/teable-ee
HARNESS_SHA=$(git rev-parse HEAD)
gh workflow run headless-bench.yml \
  --repo teableio/teable-perf-lab \
  --ref "$(git branch --show-current)" \
  -f source_sha="$(git -C "$SOURCE_ROOT" rev-parse HEAD)" \
  -f harness_sha="$HARNESS_SHA" \
  -f source_repository=teableio/teable-ee
```

For a cross-repository caller, pin the reusable workflow `uses:` revision to an
immutable teable-perf-lab commit and pass that same commit as `harness_sha`.
Pass the source event's exact checkout commit as `source_sha`; do not pass a
branch, merge ref, or abbreviated SHA. The caller must grant `contents: read`
and `actions: read`, and explicitly forward the three workflow secrets below.
The reusable workflow exposes `result`, `report_asset`, and `log_tag` outputs,
while its final `Headless benchmark result` job independently fails unless
runtime creation, all 21 matrix legs, and report publication succeed.

The workflow runs these families with 100 samples and their checked-in budgets:

```text
storage-query, write, formula, lookup, rollup, conditional-link, propagation,
api-limit, headless-http, core-operations, core-extra, core-scale,
core-transitions, core-views, core-computed-changes, core-query-cases,
core-relation-cases, core-field-transitions, core-fanout-deletion,
core-volume-cases, complexity-score
```

Each job checks out and verifies the exact harness and source SHAs. The runtime
producer installs the lab root first, prepares the source workspace, selects
pnpm from the source `package.json`, performs the filtered frozen install, and
builds the dependency closure once. Matrix jobs reproduce the same mount,
restore a dual-SHA-bound archive, and run against an isolated PostgreSQL 16
service. Each prepared leg copies `.headless-bench-source.json` to its receipt
output as `source.json`.

The report job receives the same exact `source_sha` and `harness_sha` as
expected provenance. A family summary counts only when its `source.json`
matches both revisions; missing, stale, or cross-harness evidence is reported
as a failed family instead of a pass.

## Private transport and credentials

The workflow requires the Remote CI GitHub App credentials:

- `RCI_APP_ID`
- `RCI_APP_PRIVATE_KEY`

The App installation must be able to read the selected source repository and
write releases in the private `teable-ci-logs` repository. Standalone runs with
`check_run_id` also require source `checks: write` to conclude the check and
`contents: write` to send the repository-dispatch callback. The public
teable-perf-lab checkout uses the caller's GitHub token and does not require an
App installation. App tokens are minted separately for source and log
repositories with only the read/write permissions needed by each step.

`TEABLE_EE_CHECKOUT_SSH_KEY` is an optional source-checkout fallback when the
App installation cannot read the EE repository. It does not replace the App
credentials: the private runtime, logs, evidence, and report still require an
App token for `teable-ci-logs`. Direct dispatch reads these values from the
teable-perf-lab repository secrets; a reusable caller must pass them.

The compiled archive uses a run-attempt-specific temporary release in
`teable-ci-logs`. Logs and receipts use `log_tag`, or a release scoped to the
Actions run when none is supplied. The run scope is deliberate: a partial
rerun of failed matrix legs reuses the successful siblings' archives from the
previous attempt instead of reporting them missing. Re-uploaded logs and
archives replace the same names, while the unified report asset stays
run-attempt-specific so the newest attempt is unambiguous. Its synthetic
benchmark table is written into the private release body and is not copied to
the public Actions step summary.

When `check_run_id` is empty, the workflow stops after the native final result
job and does not conclude or dispatch anything in the source repository. Direct
dispatches from this repository can patch the explicit check and send the
`ee-remote-ci-done` callback. For `workflow_call`, GitHub expressions retain the
caller's event name and repository, so the source-side wrapper owns check-run
conclusion and only consumes the reusable workflow result and private report
outputs. Benchmark execution stays here.
