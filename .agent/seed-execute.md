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

Today's 10k runners create a temporary table, seed deterministic rows, and
permanently delete the table in `finally`. That is acceptable at 10k. It is the
wrong shape for import-heavy cases (e.g. 100k rows), where the build phase should
be cacheable: first run pays, later runs restore.

## Seed Hash Contract

The seed hash is the cache key for the seed artifact.

Include in the hash: case id and runner kind; the seed-relevant config (row
count, fields, generator, relationships, batch size, fixture version); case file
content when it affects seed behavior; runner seed code and shared seed helpers;
the schema signature needed to safely restore.

Exclude from the hash: thresholds, sample count, owner, tags, description;
execute-only code (the measured field/paste/request); trace/reporting code.

If a runner cannot yet separate seed from execute code, hash the whole runner
file — conservative but correct. Later refactors should split seed builders from
execute logic so the hash can be precise.

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

When the workflow used parallel matrix jobs, it also dumped the e2e seed once
(`pg_dump -Fc`) and restored it per matrix job. That was removed for the serial
job. If matrix parallelism returns, restore that snapshot pattern before adding
more per-case setup work.

For cached seeds, also record `seedHash`, `seedCacheHit`, `seedRestoreMs`,
`seedBuildMs`, `seedReadyMs`. A cache miss is a valid run, but the report should
make the paid construction cost obvious.
