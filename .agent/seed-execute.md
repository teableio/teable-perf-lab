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
`PERF_LAB_SEED_CACHE_ENABLED=true`. It restores a Postgres custom-format dump
before the e2e app starts, then saves a fresh dump after a successful perf run.
The dump is the transport container; each runner still decides whether a
specific fixture is reusable by looking for seed tables named with that case's
`seedHash`.

The formula, conditional lookup, record delete, record undo, record redo, and
selection clear runners are cache-aware today:

- cold run: compute `seedHash`, create deterministic seed table(s), validate
  source records, execute the measured operation, then preserve or restore the
  seed table to a seed-ready state.
- warm run: restore the database dump, find the seed table(s) by hash-derived
  name, run `seedReady`/`sourceReady`, and execute the measured operation again.

Paste runners still cold-build the execute table and delete it in `finally`
because the 10k paste import is the measured workload. Caching pasted records
would turn the case into a different read/verify benchmark instead of an import
benchmark.

Some cases can be engine-specific. If an engine cannot run the same operation
shape, return a `skipped` result with a clear reason instead of silently changing
the workload. For example, V1 selection clear is skipped for the 10k stream case
because the legacy range resolution path is capped at 1,000 records.

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

CI runs all selected cases serially in one job and initializes the heavy
environment once (checkout, install, prisma, Postgres/Redis, migrate + seed,
install perf-lab cases). Inside `perf-lab.e2e-spec.ts`, each engine inits the
Nest app once and runs all selected cases in that context:

```text
engine v1 -> initApp once -> run selected cases serially
engine v2 -> initApp once -> run selected cases serially
```

So DB services, Redis, seed user, auth, and app startup are amortized across
cases — not part of any case's primary metric.

The workflow now uses the same `pg_dump -Fc` / `pg_restore` pattern for seed
reuse across workflow runs:

1. `actions/cache/restore` restores `perf-lab-seed-cache/e2e_test_teable.dump`.
2. `Prepare e2e database` restores that dump when present; if restore fails, it
   rebuilds from migrations and the normal e2e seed.
3. Case runners look for hash-derived seed table names. A cache hit skips the
   row import phase; a miss creates new seed tables.
4. After a successful run, `pg_dump -Fc e2e_test_teable` saves the database,
   including reusable seed fixtures, back into `actions/cache/save`.

The workflow cache key includes the target `teable-ee` ref, database schema
hash, perf case/framework source hash, and run id. The broad restore key allows a
previous successful dump with the same database schema to be reused; stale
per-case tables are harmless because the runner-level `seedHash` decides whether
they match the current case.

For cached seeds, also record `seedHash`, `seedCacheHit`, `seedRestoreMs`,
`seedBuildMs`, `seedReadyMs`. A cache miss is a valid run, but the report should
make the paid construction cost obvious.
