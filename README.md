# teable-perf-lab

Performance regression lab for Teable v2.

The current MVP runs perf cases through the existing `teable-ee` e2e harness.
This keeps setup lightweight: GitHub Actions checks out `teable-ee`, injects the
perf case framework, starts the same e2e Postgres/Redis services, runs the
existing seed, and executes the selected cases with `@teable/backend-ee` in one
serial job. V1 and V2 are still measured separately, but they share the same
runner checkout, dependency install, database, Redis, and e2e seed setup.

This repository is intended to become the control plane for Teable performance
regression validation:

- define reproducible performance cases as typed case configs
- run API-level end-to-end workloads through the `teable-ee` e2e entrypoint
- persist run history, metrics, artifacts, and trace snapshots
- publish manual and scheduled regression reports

The executable entrypoint is `perf-lab.e2e-spec.ts`. Case definitions live under
`cases/**/*.case.ts`, and each case must have a same-name `cases/**/*.md`
description beside it. Shared runners and artifacts live in `framework/`. Cases
are registered in `registry.ts`.

Available cases:

- `smoke/auth-user`: authenticated `GET /api/auth/user/me` smoke timing.
- `formula/10k-calc`: create 10k rows, add a formula field, and verify computed
  values are ready.
- `formula/10k-5-concurrent`: create 10k rows once, concurrently add 5 formula
  fields on the same table, and verify computed values are ready.
- `lookup/conditional-10k`: create two 10k-row tables with permuted unique keys,
  add a conditional lookup on the host table, and verify each sampled row
  returns a different source value.

For operational details, see
[docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md). The broader
design remains in [docs/plan.md](docs/plan.md).

## Case Registry

Developer-facing case metadata is mirrored into the Teable `Perf Cases` table:

- Base: `bselS3I2MeVI6RJhS4g`
- Table: `tbl0pa9PtLeNPCRNCKe`

The table stores the case id, title, owner, tags, runner, threshold, local
reproduce command, GitHub Actions reproduce command, and a GitHub URL for the
case description markdown. The sync source of truth is the repository:

- `cases/<group>/<case>.case.ts` defines executable behavior and thresholds.
- `cases/<group>/<case>.md` explains the data setup, operation, and metric.
- `registry.ts` decides which cases are runnable.

Run `pnpm check:cases` to validate the registry and markdown descriptions
without writing Teable. Run `pnpm sync:cases` with `TEABLE_PERF_LAB_TOKEN` to
upsert the table locally. GitHub Actions also runs `Sync perf cases` on pushes
to `main` that touch case definitions, descriptions, registry, or the sync
script, so the Teable table stays aligned with the repo.

## Initialization And Measurement Boundaries

The most important design rule in this repository is: **reuse the expensive e2e
environment, but keep each case's test data isolated, deterministic, and
measured in explicit phases**.

This avoids two common failure modes:

- starting a new Teable instance for every case, which makes the suite slow and
  noisy
- caching computed results or reusing dirty test tables, which makes the
  benchmark less trustworthy

### What Is Reused

The GitHub job initializes the heavy environment once:

```text
checkout teable-ee
install dependencies
generate prisma clients
start Postgres and Redis
migrate and seed the e2e database
install perf-lab cases into the teable-ee e2e test path
run the perf-lab serial spec
```

Inside `perf-lab.e2e-spec.ts`, each engine initializes the Nest e2e app once and
then runs all selected cases in that same app context:

```text
engine v1 -> initApp once -> run selected cases serially
engine v2 -> initApp once -> run selected cases serially
```

That means database services, Redis, the e2e seed user, authentication setup,
and Nest app startup are amortized across cases. They are not part of an
individual case's primary metric.

### What Is Not Reused

Case data is not shared across cases. Heavy table cases create temporary tables
with unique timestamped names, then permanently delete them in `finally`:

```text
perf-formula-10k-<timestamp>
perf-conditional-lookup-source-10k-<timestamp>
perf-conditional-lookup-host-10k-<timestamp>
```

This keeps each case close to an empty-data starting point while still avoiding
the cost of booting a new Teable instance.

Do not cache formula values, lookup values, or previously computed tables across
runs. The benchmark should measure whether Teable can compute fresh data from a
clean case-local setup.

### Deterministic Data Construction

Case data must be deterministic. The runner should be able to calculate the
expected result locally from the row number and config.

Formula cases use deterministic numeric rows:

```text
Title = Formula row <rowNumber>
A = rowNumber
B = (rowNumber % 97) + 1
C = rowNumber % 13
```

The expected formula values are computed locally, for example:

```text
({A} * {B}) + {C}
```

Conditional lookup cases use a deterministic permutation:

```text
sourceRow = ((hostRowOffset * multiplier + offset) % recordCount) + 1
```

The permutation multiplier must be coprime with `recordCount`, so each host row
maps to a unique source row. This lets the full scan prove that every row gets a
different expected lookup value, instead of accidentally testing repeated keys.

### Seed In Batches, Cache Only Sample IDs

Large data setup is written in batches, for example `10_000` records with
`batchSize = 1_000`. Batch timings are recorded as setup phases:

```text
seedBatch:1
seedBatch:2
...
seedRecordsMs
maxSeedBatchMs
```

During seeding, runners only keep the record ids needed for sample validation:

```text
rowOffset -> recordId / rowNumber
```

Do not keep all 10k records in memory just for later assertions. Full
verification should page through the real read path with `getRecords`, usually
`1_000` records at a time.

### Split Setup From The Measured Operation

When adding a heavy case, split the flow into these phases:

1. `createTable` / `createTables`: create empty temporary tables with required
   source fields.
2. `seedRecords` / `seedSourceRecords` / `seedHostRecords`: insert deterministic
   data in batches.
3. `sourceReady`: verify that source data is readable before triggering computed
   work.
4. `createFormulaField:*` / `createLookupField`: trigger the operation being
   measured.
5. `fullFormulaScanReady` / `fullLookupScanReady`: page through records until
   every computed value matches the locally expected value.
6. cleanup: permanently delete temporary tables in `finally`.

Primary metrics should focus on the operation and readiness verification, not
on setup cost:

```text
formulaFullReadyMs = formulasReadyMs + fullFormulaScanReadyMs
conditionalLookupReadyMs = createLookupFieldMs + fullLookupScanReadyMs
```

Setup metrics such as `createTableMs`, `seedRecordsMs`, and `maxSeedBatchMs`
should still be recorded. They help explain noisy runs, but they should not be
mixed into the primary computed-field metric unless the case explicitly says it
is measuring setup.

### Verification Contract

Use two levels of verification:

- sample verification: quick polling on a few known rows to confirm the system
  has started returning correct values
- full scan verification: paged read of every row to prove the computed field is
  fully ready

If a case fails, throw a diagnostic result that still includes completed phase
durations, table ids, field ids, sample records, partial metrics, and error
details. A failed run should still leave enough evidence for a developer to
understand whether the failure happened during setup, trigger, readiness
polling, full scan, or cleanup.

Wrap important phases with `withPerfTraceStep()` so trace artifacts line up with
case phases. The dashboard should be able to guide a developer from a trend
point to the exact step that consumed time.

## Adding A Case

Use this flow when adding or changing a perf case. The goal is that another
developer can understand the data, reproduce the operation, and trigger the same
case from Teable without reading the runner internals first.

1. Pick an existing runner when possible.

   Available runner kinds are defined in `framework/types.ts`:
   - `http-endpoint`: repeated requests against one authenticated endpoint.
   - `formula-table`: create a temporary table, insert deterministic numeric
     rows, create one or more formula fields, and verify computed values.
   - `conditional-lookup`: create source and host tables, insert deterministic
     key/value rows, create a conditional lookup, and verify lookup values.

   Add a new runner only when the operation cannot be expressed by these
   configs. A new runner needs type support in `framework/types.ts`, dispatch in
   `framework/run-perf-case.ts`, and a `framework/runners/*.runner.ts`
   implementation.

2. Create the case file.

   Put the executable case in:

   ```text
   cases/<group>/<case-name>.case.ts
   ```

   Use `definePerfCase()` and keep the id stable:

   ```ts
   import { definePerfCase } from "../../framework/types";

   export default definePerfCase({
     id: "<group>/<case-name>",
     title: "Human readable title",
     runner: "formula-table",
     timeoutMs: 300_000,
     config: {
       // runner-specific config
       threshold: {
         metric: "formulaFullReadyMs",
         maxMs: 60_000,
       },
     },
   });
   ```

   Case id rules:
   - Match the path: `cases/formula/10k-calc.case.ts` uses
     `formula/10k-calc`.
   - Do not rename an existing id unless you intentionally want a new Teable
     registry row and new historical grouping.
   - Prefer deterministic data generators and fixed row counts so V1/V2 and
     repeated runs are comparable.

3. Add the description markdown beside the case.

   Every case must have the same-name markdown file:

   ```text
   cases/<group>/<case-name>.md
   ```

   Start it with frontmatter:

   ```md
   ---
   owner: backend-v2
   tags:
     - formula
     - computed
     - 10k
     - v1-v2
   enabled: true
   ---
   ```

   The body should include these sections:
   - `Goal`: what regression this case is meant to catch.
   - `Data Setup`: tables, fields, row counts, generators, and important
     relationships.
   - `Operation`: ordered steps the runner performs.
   - `Primary Metric`: the metric used for threshold comparison.
   - `Notes`: useful debugging hints, phase names, or known tradeoffs.

4. Register the case.

   Add an import and include it in the `cases` array in `registry.ts`.
   Optionally add short aliases in `caseAliases` for manual triggering. The
   registry is the runnable source of truth; a `.case.ts` file that is not
   registered will fail `pnpm check:cases`.

5. Validate locally.

   From this repository:

   ```bash
   pnpm check
   ```

   This verifies formatting, workflow YAML, TypeScript syntax, and case registry
   consistency. The case check confirms:
   - every `cases/**/*.case.ts` file is registered in `registry.ts`
   - every registered case exists on disk
   - every case has a same-name markdown description
   - required metadata such as id, title, runner, timeout, and threshold can be
     parsed for Teable sync

6. Run the case in CI.

   Use GitHub Actions when you need the real e2e environment:

   ```bash
   gh workflow run "Teable EE e2e perf" \
     --repo teableio/teable-perf-lab \
     --ref main \
     -f teable_ee_ref=<teable-ee-branch-or-sha> \
     -f case_filter=<group>/<case-name> \
     -f engine_filter=v1,v2
   ```

   The same API call is what Teable buttons or automations should use:

   ```text
   POST https://api.github.com/repos/teableio/teable-perf-lab/actions/workflows/teable-ee-e2e-perf.yml/dispatches
   ```

   Body:

   ```json
   {
     "ref": "main",
     "inputs": {
       "teable_ee_ref": "<teable-ee-branch-or-sha>",
       "case_filter": "<group>/<case-name>",
       "samples": "10",
       "primary_threshold_ms": "",
       "max_parallel": "0",
       "engine_filter": "v1,v2"
     }
   }
   ```

   `samples` only controls repeated request samples for `http-endpoint` cases.
   Heavy table cases define their own scale through case config such as
   `recordCount`, formula count, lookup structure, timeout, and threshold.

7. Sync the Teable case registry.

   Pushes to `main` automatically run `Sync perf cases` and update the `Perf
Cases` table. For a local sync, run:

   ```bash
   TEABLE_PERF_LAB_TOKEN=<token> pnpm sync:cases
   ```

   After sync, the Teable row should show the case id, title, runner, threshold,
   reproduce commands, and a `Description URL` pointing to the markdown on the
   `main` branch.

8. Keep result interpretation maintainable.

   When setting thresholds, prefer a value that catches real regressions without
   being noisy on GitHub-hosted runners. For computed-field cases, include phase
   names in the markdown notes so a developer can quickly tell whether time was
   spent in setup, field creation, readiness polling, full scan verification, or
   cleanup.
