---
name: localrun
description: Operate local Teable Performance Lab runs, including teable-ee sandbox refresh, perf-lab injection, quick local runtime checks, GitHub Actions acceptance, trace artifact diagnosis, and result reporting. Use when the user mentions localrun, teable-perf-lab, Performance Lab, perf case, local teable-ee injection, refreshing teable-ee for perf tests, v1/v2 perf workflow, trace manifests, or validating a perf case before GitHub Actions.
---

# Teable Performance Lab

## Model

`teable-perf-lab` is the source of truth for perf cases, runners, trace capture,
reporting, registry, and workflow orchestration. `teable-ee` is the runtime
harness. Do not edit or commit `teable-ee` for perf-lab case work unless the user
explicitly asks.

## Paths

```text
/Users/leo/tea/tea-project/teable-perf-lab          # this repo
/Users/leo/tea/tea-project/teable-ee                 # main teable-ee checkout
/Users/leo/tea/tea-project/teable-ee-perf-local      # disposable sandbox (git worktree)
```

## Prerequisites: Local Docker Services

The e2e harness requires Postgres and Redis running locally. **Always check
before attempting a run.**

### 1. Check running containers

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Required containers and their expected ports:

| Container         | Image         | Port | Purpose        |
| ----------------- | ------------- | ---- | -------------- |
| `teable-postgres` | postgres:15.4 | 5432 | Main + data DB |
| `teable-cache`    | redis:7.2.4   | 6379 | Cache          |

### 2. Start services if missing

The easiest way is `make switch-db-mode` from the `teable-ee` checkout (or
the sandbox). It is interactive — pipe `echo "1"` when automating:

```bash
cd /Users/leo/tea/tea-project/teable-ee-perf-local
echo "1" | make switch-db-mode
```

This creates the Docker network (`teablenet-0`), starts Postgres and Redis,
runs Prisma generate + migrate deploy, and writes the correct
`PRISMA_DATABASE_URL` into `.env.development.local` / `.env.test`.

If you only need to start individual containers after the first setup:

```bash
TEABLE_EE=/Users/leo/tea/tea-project/teable-ee

# Postgres
NETWORK_MODE=teablenet-0 POSTGRES_DB=teable POSTGRES_USER=teable POSTGRES_PASSWORD=teable \
  docker compose \
    -f $TEABLE_EE/dockers/database-postgres.yml \
    -f $TEABLE_EE/dockers/networks.yml \
    up -d

# Redis
NETWORK_MODE=teablenet-0 REDIS_PASSWORD=teable \
  docker compose \
    -f $TEABLE_EE/dockers/cache-redis.yml \
    -f $TEABLE_EE/dockers/networks.yml \
    up -d
```

Wait for health checks before proceeding:

```bash
until docker inspect --format='{{.State.Health.Status}}' teable-postgres 2>/dev/null | grep -q healthy; do sleep 2; done
until docker inspect --format='{{.State.Health.Status}}' teable-cache    2>/dev/null | grep -q healthy; do sleep 2; done
```

### 3. Database connections

The e2e harness reads connection strings from `teable-ee/enterprise/app-ee/`
env files via `dotenv-flow`. Expected values (already configured by
`make switch-db-mode`):

```text
# .env / .env.test / .env.development.local
PRISMA_DATABASE_URL=postgresql://teable:teable@127.0.0.1:5432/teable?schema=public&statement_cache_size=0
BACKEND_CACHE_PROVIDER=redis
BACKEND_CACHE_REDIS_URI=redis://:teable@127.0.0.1:6379/0
```

## Prisma Schema / Migration Issues

### Symptom

The most common local failure looks like this:

```text
prisma:error
Invalid `this.migrationJobClient.spaceDataDbMigrationJob.findFirst()` invocation
Invalid value for argument `in`. Expected SpaceDataDbMigrationJobState.
```

or any Prisma `Invalid value` / `Unknown field` / enum mismatch error during a
run. This means the Prisma client or the database schema is out of sync with the
code on `origin/develop`.

### Fix

Run `pnpm install` then `make switch-db-mode` from the sandbox. This
regenerates Prisma clients and runs `prisma migrate deploy` for both
`db-main-prisma` and `db-data-prisma`:

```bash
cd /Users/leo/tea/tea-project/teable-ee-perf-local
pnpm install
echo "1" | make switch-db-mode
```

If migrations have never been applied to this Postgres instance (fresh
container, or after `docker volume rm`), you also need the e2e seed:

```bash
NODE_ENV=test pnpm -F @teable/db-main-prisma-ee prisma-db-seed -- --e2e
```

The seed creates the test user (`test@e2e.com` / `12345678`), test space, and
test base that the perf harness relies on.

### When to suspect this issue

- After `refresh-teable-ee-sandbox.sh` pulls new commits that include Prisma
  schema or migration changes.
- After recreating the Postgres container or volume.
- After a long gap between local runs.

## Quick Start

From the perf-lab repo:

```bash
pnpm check
.agents/skills/localrun/scripts/refresh-teable-ee-sandbox.sh
.agents/skills/localrun/scripts/inject-perf-lab.sh
```

Then run a case inside the sandbox:

```bash
cd /Users/leo/tea/tea-project/teable-ee-perf-local/enterprise/backend-ee

PERF_LAB_CASE_FILTER=<case-id> \
PERF_LAB_ENGINE_LIST=v1 \
PERF_LAB_MODE=execute \
NEXT_BUILD_ENV_EDITION=CLOUD \
NODE_OPTIONS='--max-old-space-size=4096' \
npx vitest run --config ./vitest-perf-lab.config.ts
```

Replace `PERF_LAB_ENGINE_LIST=v1` with `v2` or `v1,v2` as needed.

Local runtime checks are direction-finding only; GitHub Actions is the
acceptance surface.

## Workflow

1. Read repo rules before changing cases:

```bash
cd /Users/leo/tea/tea-project/teable-perf-lab
sed -n '1,220p' README.md
sed -n '1,220p' .agents/README.md
```

2. Keep changes inside perf-lab unless the user explicitly asks for adjacent
   checkout edits. Cases live in `cases/**/*.case.ts`, same-name docs in
   `cases/**/*.md`, runnable cases in `registry.ts`, shared code in `framework/`.

3. Validate, then refresh and inject for local runtime checks:

```bash
pnpm check
.agents/skills/localrun/scripts/refresh-teable-ee-sandbox.sh
.agents/skills/localrun/scripts/inject-perf-lab.sh
```

4. Verify Docker services are running and healthy (see Prerequisites above).
   If the sandbox was just refreshed or this is the first run, also run
   `pnpm install` and `echo "1" | make switch-db-mode` inside the sandbox.

5. Run the case:

```bash
cd /Users/leo/tea/tea-project/teable-ee-perf-local/enterprise/backend-ee

PERF_LAB_CASE_FILTER=<case-id> \
PERF_LAB_ENGINE_LIST=v1 \
PERF_LAB_MODE=execute \
NEXT_BUILD_ENV_EDITION=CLOUD \
NODE_OPTIONS='--max-old-space-size=4096' \
npx vitest run --config ./vitest-perf-lab.config.ts
```

6. For official acceptance, run GitHub Actions with the target `teable-ee` ref:

```bash
gh workflow run teable-ee-e2e-perf.yml \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=develop \
  -f case_filter=<case-id> \
  -f engine_filter=v1,v2 \
  -f samples=10
```

7. Download the lightweight `teable-ee-e2e-perf-results-v*` artifact (smaller and
   faster; the report job resolves it by default) and inspect trace manifests:

```bash
traces/<case-id-with-slashes-sanitized>-<engine>/manifest.json
```

Report `traceRefCount / savedTraceCount / failedTraceCount` explicitly. Only pull
the full `teable-ee-e2e-perf-v*` artifact when you need the raw Jaeger snapshot
JSON files under `traces/**/<step>-<trace-id>.json`. For the exact file list and
JSON field shapes, see [../../artifact-content.md](../../artifact-content.md) so
you can query a result without unpacking it to learn its structure first.

## Injection

The CI injection step copies `cases/`, `framework/`, `perf-lab.e2e-spec.ts`,
`registry.ts`, and `vitest-perf-lab.config.ts` into:

```text
teable-ee/community/apps/nestjs-backend/test/perf-lab/
teable-ee/enterprise/backend-ee/vitest-perf-lab.config.ts
```

The local sandbox may be reset to `origin/develop`; do not inject into a dirty
daily-development `teable-ee` checkout unless the user explicitly asks.

## Guardrails

- Do not claim runtime acceptance from `pnpm check`; it is source validation only.
- Do not hide trace warnings in the dashboard. Inspect manifest evidence first.
- Do not reduce useful trace refs just to clear counters.
- If testing latest `teable-ee`, prefer `teable_ee_ref=develop`; local state does
  not affect GitHub runs.
- Keep generated local artifacts and injected files out of perf-lab commits.
