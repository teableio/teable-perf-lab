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
- `record-paste/flat-10k-4fields-copy-paste`: create an empty 4-field table,
  paste 10k deterministic rows through `PATCH /selection/paste`, and verify the
  inserted records.

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
   - `record-paste`: create an empty table, paste deterministic clipboard-style
     content through the selection paste API, and verify inserted records.

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
