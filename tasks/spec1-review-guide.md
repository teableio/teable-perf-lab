# Spec 1 review guide — reviewing codex's Part A + Part C + G1 results

> Self-contained. A fresh agent can run this review cold. The owner is **not a
> hands-on developer and does not read diffs** — your job is to produce a plain
> PASS/FAIL verdict backed by commands you actually ran, not a "the code looks
> fine" impression. When in doubt, run a proof, don't eyeball.

## What you are reviewing

`codex` implemented the remainder of `tasks/spec1-runner-driver-skeleton.md` on
its own branch (ask which branch; it builds on `refactor/runner-lifecycle-driver`,
where **Part B is already done and is the reference for "correct"**):

- **Part A** — `framework/runner-registry.ts`; both `framework/run-perf-case.ts`
  and `framework/run-perf-seed.ts` switched from a `switch` to a table lookup.
- **Part C** — `scripts/diff-artifacts.mjs`, an artifact before/after comparator.
- **G1 verification** — the proof that migrating delete/undo/redo did not change
  behavior, produced by diffing `main` artifacts against the branch artifacts.

Do **not** re-review Part B (the driver + the three migrated runners) — it is
already accepted. Treat it as the known-good baseline.

## Section A — Run the proofs (all must pass)

On codex's branch:

1. `pnpm check` is green.
2. The migrated family still runs green on both engines. From the sandbox
   (`.agents/skills/localrun/SKILL.md` for setup; Docker `teable-postgres` +
   `teable-cache` must be up):
   ```bash
   # after .agents/skills/localrun/scripts/inject-perf-lab.sh, from
   # /Users/leo/tea/tea-project/teable-ee-perf-local/enterprise/backend-ee
   PERF_LAB_CASE_FILTER='record-delete/delete-1k,record-undo/delete-1k,record-redo/delete-1k' \
   PERF_LAB_ENGINE_LIST=v1,v2 PERF_LAB_MODE=execute \
   PERF_LAB_ARTIFACT_DIR=<dir> NEXT_BUILD_ENV_EDITION=CLOUD \
   NODE_OPTIONS='--max-old-space-size=4096' \
   npx vitest run --config ./vitest-perf-lab.config.ts
   ```
   All six runs (3 cases × v1/v2) must `pass`.
3. Codex's `scripts/diff-artifacts.mjs`, run for each case × v1 × v2 comparing a
   `main` baseline artifact against the branch artifact, must report no
   meaningful difference.

If any of these fails, the review is FAIL — stop and report.

## Section B — Scrutinize the G1 mask (the most important check)

**Why this is the linchpin:** codex wrote the comparator _and_ used it to prove
its own change is safe. A mask that is too aggressive silently hides a real
regression. Your job is to make sure the mask only drops genuinely
run-to-run-volatile fields.

1. **Read the mask list** in `scripts/diff-artifacts.mjs` against the "Volatile
   fields to mask" list in `tasks/spec1-runner-driver-skeleton.md` (Part C). It
   is a RED FLAG if the mask drops any of these _semantic_ fields (they must be
   compared, never masked):
   - metric **keys** (only the numeric _values_ may be masked),
   - `phases[].name` and their order,
   - `thresholds[].metric` / `.max` / `.unit`,
   - `details.operation`,
   - **`details.replaySetup` keys** — presence/absence matters: `record-delete`
     must have `replaySetup: undefined`; undo has 2 keys; redo has 4. A mask that
     hides this would hide the exact behavior trap Part B was careful about.
   - routing `engineMatched` / `routeMatched` / `engine` / `feature`,
   - `details.verifiedSamples[].expected`, `rowCount`, `batchSize`.
2. **Re-derive the mask empirically.** Run the _same_ branch twice and diff the
   two artifacts with codex's tool — it must pass (mask genuinely covers the
   noise). Then hand-inspect those two same-branch artifacts: the only fields
   that differ between two identical-code runs are the legitimately maskable
   ones (timestamps, durations, metric values, generated ids, seed hash, trace
   observability). If something else drifts run-to-run, the mask or the runner
   is wrong.
3. **Prove the tool can fail.** Take one passing artifact, perturb a _semantic_
   field by hand (rename a phase, drop a metric key, flip `details.operation`),
   and confirm `diff-artifacts.mjs` now **fails**. If it still passes, the
   comparator is over-masked or broken — RED FLAG, the whole G1 proof is void.

## Section C — Part A behavior-preservation red flags

Part A must be pure indirection. Read these specific spots:

- Every `runnerRegistry` entry's `execute` / `seed` points to the **same
  function with the same arguments** the old `switch` arm used. Cross-check
  against `git show main:framework/run-perf-case.ts` and `…run-perf-seed.ts`.
- The `record-delete` / `record-undo` / `record-redo` seed entries still forward
  `perfCase.runner` into `seedRecordUndoRedoCase(perfCase, context, perfCase.runner)`.
- The `http-endpoint` / `record-paste` / `table-create` seed entries reproduce
  the old `skipped` object byte-for-byte (`result`, `metrics`, `thresholds`,
  `details.reason`, `details.runner`).
- An unknown runner kind still throws (the old `default:` behavior).
- The table has **exactly one entry per `PerfRunnerKind`** — none missing, none
  duplicated. Count entries against the `PerfRunnerKind` union in
  `framework/types.ts`.

## Section D — Scope / constraint red flags

- `git diff --stat main...<branch>`: nothing under `../teable-ee`; no edits to
  `framework/types.ts` config interfaces, `registry.ts`, `cases/**`, case ids,
  or the artifact JSON shape in `framework/artifacts.ts`.
- No other runner family was migrated; no Spec 2–4 guardrails were added.
- Pre-existing untracked files (`.DS_Store`, `tasks/v2-trace-bsp-drop-blocker.md`)
  are untouched / not committed.

## Section E — Report format

Produce, in plain language for the owner:

- A PASS/FAIL line for each of Sections A–D.
- The 1–3 things that genuinely needed human judgment (especially the mask
  verdict from Section B) and what you concluded.
- One-line recommendation: **merge** / **fix-then-merge** (list the fixes) /
  **reject**.

Do not claim runtime acceptance from `pnpm check` alone — it is source
validation only. The G1 diff + the live v1/v2 run are the behavioral proof.
