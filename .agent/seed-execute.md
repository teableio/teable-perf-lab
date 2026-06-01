# Seed vs Execute Boundary

The most important design rule: **every non-trivial case has two explicit
stages, `seed` and `execute`**. Keep them separate.

Three layers must not be mixed:

- **Environment bootstrap**: checkout, install, Postgres/Redis, migrations, e2e
  seed, Nest app startup. Amortized by CI across all cases — never part of a
  case's metric.
- **Case fixture setup (seed)**: deterministic source tables/records the case
  needs before measuring (e.g. a 10k or future 100k-row table).
- **Measured operation (execute)**: the operation the case actually times, plus
  its readiness verification.

The first two may be reused/restored while their cache key is valid. The measured
operation must stay fresh every run.

## Runner Architecture

```text
resolve case
compute seed hash from case seed config + seed code
restore seed artifact by hash
if missing: run seed stage, validate fixture, save seed artifact
run execute stage against restored fixture
collect metrics, traces, verification evidence
cleanup execute-only changes
```

## Phases

1. `seedHash`: cache key from seed config + seed code.
2. `seedRestore` / `seedBuild`: restore cached fixture, else create tables and
   insert deterministic data in batches.
3. `seedReady` / `sourceReady`: verify record count, field layout, sample values,
   and any indexes/links the case needs.
4. trigger the measured operation (create field / paste / stream request).
5. full-scan readiness: page through records until every value matches the
   locally expected value.
6. cleanup: remove per-run measured fields / derived temp tables. Preserve
   reusable source fixtures unless the key is invalid or the case intentionally
   measures cold import.

## Current State

The GitHub workflow enables seed caching with
`PERF_LAB_SEED_CACHE_ENABLED=true`. A dedicated seed job restores a Postgres
custom-format dump before the e2e app starts, runs only the selected runners'
seed paths in a legacy-compatible bootstrap mode, validates every selected
fixture, and uploads a fresh dump for the execute jobs. The dump is the
transport container; each runner still decides whether a specific fixture is
reusable by looking for seed tables named with that case's `seedHash`.

The formula, conditional lookup, record delete, record undo, record redo, and
selection clear runners are cache-aware today:

- seed miss: compute `seedHash`, create deterministic seed table(s), validate
  source records, and include those tables in the seed database dump.
- seed hit: restore the database dump, find the seed table(s) by hash-derived
  name, and run `seedReady`/`sourceReady` before dumping again.
- execute run: restore the seed dump into an isolated engine database, run
  `seedReady`/`sourceReady`, and then execute the measured operation.

Paste runners still cold-build the execute table and delete it in `finally`
because the 10k paste import is the measured workload. Caching pasted records
would turn the case into a different read/verify benchmark instead of an import
benchmark.

Some cases can be engine-specific. If an engine cannot run the same operation
shape, return a `skipped` result with a clear reason instead of silently changing
the workload.

## Seed Hash Contract

The seed hash is the cache key for the seed artifact.

Include in the hash: case id and runner kind; the seed-relevant config (row
count, fields, generator, relationships, batch size, fixture version); case file
content when it affects seed behavior; runner seed code and shared seed helpers;
the schema signature needed to safely restore.

Exclude from the hash: thresholds, sample count, owner, tags, description;
execute-only code (the measured field/paste/request); trace/reporting code.

If a runner cannot yet separate seed from execute code, hash the whole runner
file — conservative but correct. The shared helper also hashes the matching
`cases/<case-id>.case.ts` file when it can find it, so config-only changes
invalidate the seed. Later refactors should split seed builders from execute
logic so the hash can be more precise.

Seed artifacts must carry enough metadata to prove safe reuse:

```text
caseId, runner, seedHash, fixtureVersion, recordCount,
tableIds / baseId or snapshot location, field ids and layout,
sample record ids or deterministic lookup rules, createdAt, schemaSignature
```

On a cache hit, still run a fast `seedReady` validation (table existence, field
layout, record count, a few sample values) before `execute`. If it fails,
discard the artifact and rebuild.

### Cache Key Shape

```text
<case-id>:<runner>:<fixture-version>:<record-count>:<field-layout>:<generator-version>:<seed-code-hash>:<schema-signature>
```

`schema-signature` is tied to the database shape the fixture depends on, not to
every source commit. If a looser restore key picks up an older compatible
fixture, the case must validate the restored table before measuring.

## Execute Stage

Runs after `seedReady`, even on a cache hit. Do **not** cache the computed
formula, lookup, rollup, pasted records, or a previously measured result unless
the case is explicitly designed to measure reads from a precomputed state. For
normal regression cases, create a fresh measured field/workload on the restored
seed, measure it and its readiness.

Execute cleanup removes only per-run measured changes (measured fields,
execute-only temp tables, records created by an execute workload such as paste).
It must not delete reusable seed tables on a cacheable case.

## CI Reuse Today

CI splits seed construction from measured execution:

```text
seed job -> restore cached DB or migrate + e2e seed -> initApp once in seed bootstrap mode -> seed all selected fixtures -> pg_dump
execute v1 job -> restore seed dump -> initApp once -> run selected cases serially
execute v2 job -> restore seed dump -> initApp once -> run selected cases serially
```

The execute jobs run in parallel when `engine_filter=v1,v2`. Each execute job
has its own Postgres/Redis containers, so destructive cases can delete or clear
their restored seed tables without corrupting the other engine's copy.

The workflow now uses the same `pg_dump -Fc` / `pg_restore` pattern for seed
reuse across workflow runs:

1. `actions/cache/restore` restores `perf-lab-seed-cache/e2e_test_teable.dump`.
2. `Prepare e2e database` restores that dump when present; if restore fails, it
   rebuilds from migrations and the normal e2e seed.
3. The seed job runs `PERF_LAB_MODE=seed`. The seed app sets
   `FORCE_V2_ALL=false` because the seed only creates source fixtures; V1/V2
   differences are introduced later by the execute jobs. Case runners look for
   hash-derived seed table names. A cache hit skips the row import phase; a miss
   creates new seed tables.
4. After a successful seed job, `pg_dump -Fc e2e_test_teable` saves the
   database, including reusable seed fixtures, into both `actions/cache/save`
   and a run artifact.
5. Each execute job downloads that exact run artifact, restores it, sets
   `PERF_LAB_EXECUTE_DB_ISOLATED=true`, and runs the measured operations.

The workflow cache key includes the target `teable-ee` ref, database schema
hash, perf case/framework source hash, and run id. The broad restore key allows a
previous successful dump with the same database schema to be reused; stale
per-case tables are harmless because the runner-level `seedHash` decides whether
they match the current case.

`PERF_LAB_EXECUTE_DB_ISOLATED=true` tells destructive runners that their current
database is disposable after the engine job finishes. In that mode cleanup can
skip expensive seed restoration after a delete or clear operation because the
next engine already has its own restored copy and the next workflow run starts
from the seed job dump, not from the mutated execute database.

For cached seeds, also record `seedHash`, `seedCacheHit`, `seedRestoreMs`,
`seedBuildMs`, `seedReadyMs`. A cache miss is a valid run, but the report should
make the paid construction cost obvious.
