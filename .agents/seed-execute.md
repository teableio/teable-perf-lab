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

Environment bootstrap is amortized by CI. Case seed fixtures may be
reused/restored while their cache gates pass. The measured operation must stay
fresh every run.

## Two Cache Layers

There are two different cache decisions. Do not collapse them:

- **Workflow DB dump cache**: GitHub Actions restores/saves
  `perf-lab-seed-cache/e2e_test_teable.dump`. This is a whole Postgres database
  snapshot used as a transport container. Its exact key binds runner OS,
  database schema, seed-contract generation, stable shard slot, full case-set
  digest, and perf-lab source hash. Its compatible prefix stops at the stable
  slot and cannot bypass runner validation. Neither form includes the target
  `teable-ee` commit ref.
- **Runner `seedHash`**: after the dump is restored, each runner looks for its
  own hash-derived seed table(s), then runs `seedReady`/`sourceReady`. This is
  the per-case correctness gate. A restored dump may contain stale tables; they
  are ignored unless the runner hash and readiness checks pass.

## Runner Architecture

```text
resolve case
restore workflow DB dump by exact key or restore-key
compute runner seedHash from case seed config + seed code
find hash-derived seed table(s) inside the restored database
if missing or not ready: run seed stage, validate fixture, include it in the dump
run execute stage against restored fixture
collect metrics, traces, verification evidence
cleanup execute-only changes
```

## Phases

1. workflow cache restore: restore the database dump, or start from migrations
   and the normal e2e seed.
2. `seedHash`: per-runner table identity from seed config + seed code.
3. `seedRestore` / `seedBuild`: find a matching fixture in the dump, else create
   tables and insert deterministic data in batches. Batch the inserts with
   `chunk(items, size)` from `framework/chunk.ts` instead of hand-rolling the
   slicing loop.
4. `seedReady` / `sourceReady`: verify record count, field layout, and the
   sample values / indexes / links the case needs. Capture the seed-time
   verification samples with `collectSampleRecords(map, wanted, inputs, records)`
   (and the `SeededSampleRecord` type) from `framework/sample-records.ts`.
5. trigger the measured operation (create field / paste / stream request).
6. full-scan readiness: page through records until the final-state contract is
   proven, such as computed values matching, cells empty, table empty, or row
   count restored. Use `forEachRecordPage({ totalRows, pageSize, fetchPage })`
   from `framework/record-page-scan.ts` for the paged full-scan loop (it owns the
   skip/take paging, the per-page bounds guard, and the scanned/page counts), and
   `pollUntilReady({ timeoutMs, pollIntervalMs, description }, assertFn)` from
   `framework/readiness.ts` for any "retry the assertion until it stops throwing
   or times out" wait. Do not open-code either loop.
7. cleanup: remove per-run measured fields / derived temp tables. Preserve
   reusable source fixtures unless the key is invalid or the case intentionally
   measures cold import.

## Current State

The GitHub workflow enables seed caching with
`PERF_LAB_SEED_CACHE_ENABLED=true`. The dump is the transport container; each
runner still decides whether a specific fixture is reusable by looking for seed
tables named with that case's `seedHash`.

The seed DB cache uses an exact key plus a compatible restore prefix:

```text
exact:      perf-seed-db-<runner-os>-<teable-prisma-schema-hash>-<seed-contract-generation>-<stable-slot>-<case-set-digest>-<perf-lab-source-hash>
compatible: perf-seed-db-<runner-os>-<teable-prisma-schema-hash>-<seed-contract-generation>-<stable-slot>-
```

`teable-prisma-schema-hash` is `hashFiles()` over these checked-out `teable-ee`
paths:

```text
teable-ee/packages/db-main-prisma/prisma/postgres/schema.prisma
teable-ee/packages/db-main-prisma/prisma/postgres/migrations/**
teable-ee/community/packages/db-data-prisma/prisma/schema.prisma
teable-ee/community/packages/db-data-prisma/prisma/migrations/**
```

`perf-lab-source-hash` is `hashFiles()` over:

```text
perf-lab/cases/**/*.case.ts
perf-lab/framework/**/*.ts
perf-lab/perf-lab.e2e-spec.ts
perf-lab/registry.ts
```

Both forms deliberately exclude `inputs.teable_ee_ref`. The exact key binds the
complete sorted shard case set and seed-relevant perf-lab source. The compatible
prefix is scoped to runner OS, schema/migrations, seed contract generation, and
stable shard slot. It permits safe catalog or source changes to restore an old
dump only as a candidate; `PERF_LAB_MODE=seed` must then validate every runner's
seed identity/readiness and rebuild missing or stale fixtures before saving a
new exact snapshot.

All runners with a seed fixture are cache-aware today (formula-table,
conditional-lookup, conditional-lookup-record-create, conditional-rollup, conditional-query, lookup-search-index, field-create, field-delete,
field-convert, field-duplicate, csv-import inplace, record-create,
record-update, record-reorder, record-delete, record-undo, record-redo,
selection-clear):

- seed miss: compute `seedHash`, create deterministic seed table(s), validate
  source records, and include those tables in the seed database dump.
- seed hit: restore the database dump, find the seed table(s) by hash-derived
  name, and run `seedReady`/`sourceReady` before dumping again.
- execute run: restore the seed dump into an isolated engine database, run
  `seedReady`/`sourceReady`, and then execute the measured operation.

CSV import caches the empty target table shape and best-effort import
attachment metadata; execute still performs a fresh import and deletes the
mutated table afterward. Paste runners still cold-build the execute table and
delete it in `finally` because the 10k paste import is the measured workload.
Caching pasted records would turn the case into a different read/verify
benchmark instead of an import benchmark.

Some cases can be engine-specific. If an engine cannot run the same operation
shape, return a `skipped` result with a clear reason instead of silently changing
the workload. Before adding a skip, first check whether the case should be
reshaped to a smaller but equivalent V1/V2 comparison, such as using a 1k range
when the V1 path has a 1,000-record cap.

## Runner Seed Hash Contract

`seedHash` is not the GitHub Actions cache key. It is the runner's identity for
reusable fixture tables inside a restored database dump.

When multiple cases intentionally reuse one physical fixture, each case must
declare the same top-level string-literal `seedAffinity`. The runner resolves
its seed identity from that value, the full-run planner treats those cases as
one indivisible bundle, and `SeedCacheInfo` carries the value into result
artifacts. Only share an affinity when the seed-relevant config and seed code
produce the same physical tables; query or threshold similarity is not enough.

Include in the hash: the resolved seed identity (case id, or shared
`seedAffinity`) and runner kind; the seed-relevant config (row count, fields,
generator, relationships, batch size, fixture version); case file content when
it affects seed behavior; runner seed code and shared seed helpers; the schema
signature needed to safely restore.

Exclude from the hash: thresholds, sample count, owner, tags, description;
execute-only code (the measured field/paste/request); trace/reporting code.

If a runner cannot yet separate seed from execute code, hash the whole runner
file — conservative but correct. The shared helper also hashes the matching
`cases/<case-id>.case.ts` file when it can find it, so config-only changes
invalidate the seed. Later refactors should split seed builders from execute
logic so the hash can be more precise.

Seed fixture metadata must carry enough information to prove safe reuse:

```text
caseId, runner, seedHash, fixtureVersion, recordCount,
tableIds / baseId or snapshot location, field ids and layout,
sample record ids or deterministic lookup rules, createdAt, schemaSignature
```

On a cache hit, still run a fast `seedReady` validation before `execute`: table
existence, field layout, record count, and whatever sample values or relationship
checks the case needs. If it fails, discard the fixture and rebuild.

### Runner Seed Hash Shape

```text
<case-id>:<runner>:<fixture-version>:<record-count>:<field-layout>:<generator-version>:<seed-code-hash>:<schema-signature>
```

`schema-signature` is tied to the database shape the fixture depends on, not to
every source commit. If a restore-key path picks up an older dump with the same
schema hash, the runner must validate the restored table before measuring.

## Cleanup Strategy: Pick by What Execute Does to the Seed

Two invariants drive every cleanup decision. Memorize these before reading
the table:

1. **A cached seed table must be in seed-ready state whenever the next run
   finds it — otherwise it must not exist.** Leaving a mutated table behind
   on a durable database creates silent dirty cache, the worst failure mode.
   (Three defenses back this up: the hash-derived table name, the cache-hit
   `seedReady` revalidation, and delete-on-failed-restore.)
2. **On an isolated database (`PERF_LAB_EXECUTE_DB_ISOLATED=true`) skip cleanup
   unless sibling cases in the same process reuse a fixture mutated by
   execute.** The whole database is dropped after the job, so restore or delete
   is normally wasted work. The exception must restore and revalidate the seed
   between sibling cases so their workloads remain independent.

To pick a strategy for a new case, answer one question — _what does the
measured operation do to the seed fixture?_ — and use the matching class:

| Class | Execute does ... to the seed                                   | Local (non-isolated) cleanup                                                  | Runners                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | nothing reusable exists; the workload itself builds the table  | delete the per-run table                                                      | http-endpoint (no fixture at all), record-paste, csv-import create-table                                                                                                                                  |
| B     | only adds new objects next to it (fields) or reads it          | delete the execute-created objects, keep the seed table                       | formula-table, conditional-lookup, conditional-rollup, conditional-query create cases, field-duplicate, field-create, lookup-search-index (read-only: nothing to clean)                                   |
| C     | mutates it in a cheaply reversible way                         | reverse the mutation, verify seed-ready again, delete the table if that fails | conditional-lookup-record-create, conditional-query propagation cases, record-create (delete created rows), record-update (rewrite seed values), record-reorder, selection-clear, record-delete/undo/redo |
| D     | mutates it irreversibly (restoring costs as much as reseeding) | delete the table; the next run or seed job rebuilds it                        | field-delete, field-convert, csv-import inplace                                                                                                                                                           |

Decision order when writing a new runner:

1. Execute only creates new objects? → **B**.
2. The reverse operation is clearly cheaper than reseeding? → **C**.
3. Otherwise → **D**. Never attempt a "best effort" partial restore.

Rules that apply to every class:

- The isolated short-circuit comes first in `finally` unless multiple selected
  cases share an execute-mutated fixture in the same engine process. That
  runner must restore and revalidate between cases even in an isolated job.
- Any local restore must be verified at `seedReady` level afterwards; on any
  failure, delete the table rather than keep a possibly-dirty fixture.
- Cache-hit paths must self-heal leftovers from crashed or isolated runs:
  B-class runners delete leftover non-seed fields before reuse; D-class
  runners detect the mutated column during revalidation and rebuild.
- Class choice is normally about the _local_ durable database only. On CI all
  four classes skip cleanup because the database is discarded, except a shared
  fixture must still be restored between sibling cases in the same process.

Note the asymmetry this creates between environments: on CI, "cache hit"
means the seed job built the table once into the dump and every engine job
gets a pristine copy for free. Locally, C-class runners keep their cache
alive by restoring it, while D-class (and A-class) runners pay a rebuild on
every run — that is a deliberate trade, because their restore would cost as
much as the rebuild.

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
seed shard N -> restore shard cache or migrate + e2e seed -> initApp once -> seed shard N fixtures -> bounded trace tail -> pg_dump N
execute v1 shard N -> restore seed dump N -> initApp once -> run shard N serially -> bounded trace tail
execute v2 sync/hybrid shard N -> restore seed dump N -> initApp once -> run its mode subset serially -> bounded trace tail
```

The seed and execute jobs run in parallel for a full `case_filter=all` run.
Every case writes its measured payload before trace retrieval. One job-tail
flush/settle/fetch pass then finalizes all per-case manifests and rewrites only
their trace blocks, so Jaeger waiting is outside case duration and is bounded by
the shared job budget.
`scripts/run-plan.mjs` reads literal `seedAffinity` declarations from registered
case contracts and merges them with the accepted legacy affinity families in
`scripts/full-run-shard-model.mjs`. Every resulting physical-fixture family is
one indivisible bundle. Planning fails if an affinity is duplicated, references
an unknown case, crosses V2 sync/hybrid pools, or ends up in multiple seed
shards. Each bundle has independent cold seed, V1, V2 sync, V2 hybrid, and trace
costs. Shared-fixture seed cost uses the maximum member cost because the fixture
is built once; execute and trace costs are summed per case. The versioned
calibration imports complete V1/V2 artifact durations plus the observed 100k
record-read/search cold-seed durations from trusted run `29917985095`.

The planner simulates 6–12 shards and selects the lowest concurrency that meets
the 45-minute cold and 25-minute warm SLOs without exceeding the modeled cold or
warm path of the old scalar eight-shard assignment. Accepted affinity bundles
retain historical stable slots only when stage load permits; every forced move
and its estimated cache impact is written to the plan summary. The summary also
records each candidate's stage maxima and critical shards, job concurrency, and
predicted costs. Only stages selected by `engine_filter` and
`computed_update_mode` participate in packing or concurrency totals. Historical
slots cover singleton bundles as well as declared shared affinities, so cache
movement accounts for all changed fixture slots.

After execute completes, the report job observes the current GitHub jobs,
trace-manifest timing, and every shard's seed cache-status artifact. An all
`cache-miss` seed matrix is compared with the cold-seed prediction; only an all
`exact-hit` matrix is compared with the warm-seed prediction. Compatible,
mixed, missing, or incomplete cache evidence remains explicitly unclassified.
A missing trace manifest is also a missing observation, never a successful zero
wait. The report appends the valid prediction delta and uploads a
machine-readable observation artifact. Seed, V1, V2 sync, and V2 hybrid use one
global mapping; shard N always consumes dump N. Explicit case filters remain a
single seed job and a single job per engine. Every job has its own
Postgres/Redis containers, network, cache key, dump, and artifact names. A
digest of the shard's sorted case set is part of its exact cache key, so
regrouping cannot exact-hit a dump produced for different members.

The workflow uses `actions/cache`, same-run artifacts, `pg_dump -Fc`, and
`pg_restore` in three paths:

1. Exact seed DB cache hit: the tested cache-mode step maps the cache action's
   exact-hit signal to `requires_seed_validation == 'false'`. The seed job only
   asserts that `e2e_test_teable.dump` exists and writes a summary. It skips
   dependency install, service startup, `PERF_LAB_MODE=seed`, and seed
   validation.
2. Cache miss or compatible-prefix hit: the seed job records a cache-status JSON,
   installs dependencies, starts Postgres/Redis, and runs `Prepare e2e database`.
   If a restored dump file is present, it tries `pg_restore`; on restore failure,
   it rebuilds from migrations and `prisma-db-seed -- --e2e`. It then runs
   `PERF_LAB_MODE=seed`, where every cache-aware runner validates existing
   hash-derived seed tables or rebuilds missing/stale fixtures. A successful
   seed job saves a new exact-key `pg_dump -Fc`.
3. Each seed job uploads the selected dump as a
   `teable-ee-e2e-perf-seed-db-shard-N-of-M-<run>` artifact. Execute shard N
   downloads that artifact, restores it into its own database, sets
   `PERF_LAB_EXECUTE_DB_ISOLATED=true`, and runs
   `PERF_LAB_MODE=execute`. Cache-aware runners run `seedReady`/`sourceReady`
   before measuring execute.

`PERF_LAB_EXECUTE_DB_ISOLATED=true` tells every runner that its current
database is disposable after the engine job finishes. Cleanup is skipped unless
another case later in the same shard reuses the same fixture. Shared mutable
fixtures must still be restored and revalidated between sibling cases; after the
last sibling, the disposable database can be abandoned. The next engine has its
own restored copy and the next workflow run starts from the seed dump, never
from the mutated execute database.

Restore-style table lifecycle cases are a narrow fixture-count optimization:
one active table fixture is reused for every measured sample because each
sample already archives, restores, and verifies that table back to seed-ready
state. Seed mode therefore builds one fixture even when the case measures 5 or
10 samples. This is not execute cleanup; the restore is the measured operation
and the full scan is its normal verification. Delete-style lifecycle cases keep
separate fixtures unless their measured delete is explicitly reversed between
samples. The plain table-delete runner takes that explicit path: it restores
and revalidates the table between measured samples, while link-detach delete
keeps separate fixtures because V1 destructively converts the surviving link
field.

For cached seeds, also record `seedAffinity` when declared, `seedHash`,
`seedCacheHit`, `seedRestoreMs`, `seedBuildMs`, and `seedReadyMs`. A cache miss is
a valid run, but the report should make the paid construction cost obvious. If
one `seedHash` is observed in multiple shards, classify the static contract as
missing, declared-but-split, or mapping the same hash to multiple affinities.
