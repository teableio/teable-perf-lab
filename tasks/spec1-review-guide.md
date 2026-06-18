# Spec 1 review guide — reviewing codex's Part A + Part C + G1 results

> Status: completed. Kept as a reference template for future review runbooks.
> Use `tasks/runner-framework.md` for the current framework plan and
> `tasks/runner-migration-tracker.md` for current migration status.
>
> **Read this top to bottom and execute it.** You are a fresh agent with no prior
> context on this work — everything you need is in this file plus the repo.
>
> The owner is **not a hands-on developer and does not read diffs**. A review
> that says "the code looks reasonable" is worthless to them. Your output must be
> a plain PASS/FAIL verdict where each PASS is backed by a command you actually
> ran and an output you actually saw. When unsure, run a proof — do not eyeball.

---

## 0. Background (so the checks make sense)

`teable-perf-lab` defines performance regression cases for Teable and runs them
through the `teable-ee` e2e harness on two engines, **v1** and **v2**. Each case
has a _runner_ (the reusable execution shape) under `framework/runners/`. A run
produces a per-case **artifact JSON** (metrics, phases, routing, verification
evidence) — that JSON is the behavioral fingerprint you will compare.

This review covers an incremental refactor ("Spec 1", see
`tasks/spec1-runner-driver-skeleton.md`). It has parts:

- **Part B (already done, already accepted — your baseline of "correct"):** the
  three runners `record-delete`, `record-undo`, `record-redo` were rewritten to
  share one lifecycle driver, `framework/runners/record-replay-lifecycle.ts`
  (`runRecordReplayLifecycle` + `RecordReplaySpec`). Behavior was preserved and
  verified live on v1+v2. **Do not re-review Part B.**
- **Part A (codex — review this):** `framework/runner-registry.ts`, a single
  dispatch table that replaces the `switch` in `framework/run-perf-case.ts`
  (`runCaseByKind`) and `framework/run-perf-seed.ts` (`seedCaseByKind`). Must be
  pure indirection — zero behavior change.
- **Part C (codex — review this):** `scripts/diff-artifacts.mjs`, a tool that
  compares two artifact JSON files after masking run-to-run-volatile fields.
- **G1 (codex — review the result):** the proof that the whole change did not
  alter behavior, produced by diffing `main` artifacts against branch artifacts.

**The central risk you exist to catch:** codex _wrote_ the comparator (Part C)
_and_ used it to prove its own change is safe. If its mask hides too much, a real
regression passes silently. Section 4 is therefore the most important part of
this review — do not rush it.

## 1. File / path map

```
/Users/leo/tea/tea-project/teable-perf-lab            # this repo (perf-lab source)
/Users/leo/tea/tea-project/teable-ee                  # runtime harness — DO NOT EDIT
/Users/leo/tea/tea-project/teable-ee-perf-local       # disposable sandbox (perf-lab gets injected here)
```

Key files: `framework/runner-registry.ts` (Part A, new),
`framework/run-perf-case.ts` + `framework/run-perf-seed.ts` (Part A, edited),
`scripts/diff-artifacts.mjs` (Part C, new),
`framework/runners/record-replay-lifecycle.ts` + `record-{delete,undo,redo}.runner.ts`
(Part B, already accepted), `tasks/spec1-runner-driver-skeleton.md` (the spec).

## 2. Prerequisites

- Get **codex's branch name** from the owner. Call it `$BR`. It builds on
  `refactor/runner-lifecycle-driver`.
- Docker services must be up and healthy:
  ```bash
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'teable-postgres|teable-cache'
  ```
  Both must show `healthy`. If missing, see
  `.agents/skills/localrun/SKILL.md` → "Prerequisites: Local Docker Services".
- Read `.agents/skills/localrun/SKILL.md` once for sandbox mechanics, and
  `tasks/spec1-runner-driver-skeleton.md` (especially "Part C") for the
  authoritative mask spec.

---

## 3. Section A — Scope & static checks

Run from the perf-lab repo on `$BR`.

1. **Scope diff** — nothing out of bounds:

   ```bash
   git diff --stat main...$BR
   ```

   PASS requires: changes confined to `framework/runner-registry.ts`,
   `framework/run-perf-case.ts`, `framework/run-perf-seed.ts`,
   `scripts/diff-artifacts.mjs` (plus the already-accepted Part B files and
   `tasks/*.md`). **RED FLAG** if it touches `framework/types.ts` config
   interfaces, `registry.ts`, `cases/**`, case ids, the artifact shape in
   `framework/artifacts.ts`, anything under `../teable-ee`, or migrates any other
   runner family. Also confirm pre-existing untracked files (`.DS_Store`,
   `tasks/v2-trace-bsp-drop-blocker.md`) were **not** committed.

2. **Source validation**:
   ```bash
   pnpm check
   ```
   Must be green. (This is source validation only — it is NOT runtime
   acceptance. Do not let a green `pnpm check` stand in for Sections C/D.)

## 4. Section B — Part A registry is pure indirection

The registry must dispatch to the **same function with the same arguments** the
old `switch` did. Get the authoritative "before" from `main`:

```bash
git show main:framework/run-perf-case.ts   # runCaseByKind switch — execute side
git show main:framework/run-perf-seed.ts   # seedCaseByKind switch — seed side
```

Then open `framework/runner-registry.ts` on `$BR` and check, entry by entry:

- **Execute side:** every `PerfRunnerKind` maps to the exact `run<X>Case`
  function the old `runCaseByKind` arm called.
- **Seed side, the only non-mechanical arms** (verify these specifically):
  - `record-delete`, `record-undo`, `record-redo` must each call
    `seedRecordUndoRedoCase(perfCase, context, perfCase.runner)` — i.e. forward
    `perfCase.runner`, not a hardcoded string.
  - `http-endpoint`, `record-paste`, `table-create` must reproduce the old
    `skipped` object **byte-for-byte**: `{ result: "skipped", metrics: {},
thresholds: [], details: { skipped: true, reason: "This runner does not have
a reusable seed phase.", runner: perfCase.runner } }`.
  - every other kind maps to its `seed<X>Case`.
- **Unknown kind** still throws (old `default:` behavior preserved).
- **Coverage:** the table has exactly one entry per `PerfRunnerKind` — none
  missing, none duplicated. Count against the `PerfRunnerKind` union in
  `framework/types.ts`:
  ```bash
  grep -c '"' framework/runner-registry.ts   # sanity only; do the real 1:1 read
  ```

This section is a careful read, but it is bounded and mechanical. If every arm
matches and coverage is exact, Part A is PASS.

## 5. Section C — Produce baseline + candidate artifacts (the live run)

You need artifacts from **main** (old runners) and from **`$BR`** (new), for all
three cases on both engines. Use git worktrees so you never switch branches in
place:

```bash
cd /Users/leo/tea/tea-project/teable-perf-lab
git worktree add /tmp/plab-main  main
git worktree add /tmp/plab-cand  $BR

CASES='record-delete/delete-1k,record-undo/delete-1k,record-redo/delete-1k'
SANDBOX=/Users/leo/tea/tea-project/teable-ee-perf-local

run_one () {  # $1 = perf-lab source dir, $2 = artifact out dir
  PERF_LAB="$1" TEABLE_EE_SANDBOX="$SANDBOX" \
    "$1/.agents/skills/localrun/scripts/inject-perf-lab.sh"
  ( cd "$SANDBOX/enterprise/backend-ee" && \
    PERF_LAB_CASE_FILTER="$CASES" PERF_LAB_ENGINE_LIST=v1,v2 PERF_LAB_MODE=execute \
    PERF_LAB_ARTIFACT_DIR="$2" NEXT_BUILD_ENV_EDITION=CLOUD \
    NODE_OPTIONS='--max-old-space-size=4096' \
    npx vitest run --config ./vitest-perf-lab.config.ts )
}

rm -rf /tmp/plab-base-art /tmp/plab-cand-art
run_one /tmp/plab-main /tmp/plab-base-art   # baseline (main)
run_one /tmp/plab-cand /tmp/plab-cand-art   # candidate ($BR)
```

PASS requires: both runs finish with `Test Files 1 passed` and every case-level
`result` is `pass` (no `PerfRunDiagnosticError`, no routing assertion failure).
Artifacts land as `<case-id-sanitized>-<engine>.json`, e.g.
`record-delete-delete-1k-v1.json`.

> If the sandbox is stale (Prisma enum / schema errors), follow
> `.agents/skills/localrun/SKILL.md` → "Prisma Schema / Migration Issues" before
> concluding FAIL.

## 6. Section D — Run codex's comparator, then prove it can fail

1. **Run G1 for every case × engine:**

   ```bash
   for f in record-delete-delete-1k record-undo-delete-1k record-redo-delete-1k; do
     for e in v1 v2; do
       echo "== $f-$e =="
       node /tmp/plab-cand/scripts/diff-artifacts.mjs \
         /tmp/plab-base-art/$f-$e.json /tmp/plab-cand-art/$f-$e.json
     done
   done
   ```

   All six must report no meaningful difference (exit 0). Any real difference is
   a behavior regression → FAIL.

2. **Prove the comparator is not a rubber stamp** (this is mandatory — a tool
   that always passes is worse than no tool):
   ```bash
   cp /tmp/plab-cand-art/record-undo-delete-1k-v1.json /tmp/perturbed.json
   # flip a SEMANTIC field by hand, then diff against the unperturbed baseline:
   #   e.g. change "operation":"undo" -> "operation":"redo"
   #   or rename a phase  "undoReplay1kMs" -> "xReplay1kMs"
   #   or delete the "undoReplay1kMs" metric key
   node /tmp/plab-cand/scripts/diff-artifacts.mjs \
     /tmp/plab-base-art/record-undo-delete-1k-v1.json /tmp/perturbed.json
   ```
   This **must FAIL**. If it passes, the comparator is over-masked or broken and
   the entire G1 proof is void → FAIL the review.

## 7. Section E — Scrutinize the mask (the most important judgment)

Open `scripts/diff-artifacts.mjs` and read exactly which fields it masks.
Cross-check against `tasks/spec1-runner-driver-skeleton.md` → "Part C → Volatile
fields to mask".

**Only these are legitimately maskable** (they differ between two identical-code
runs): timestamps (`startedAt`/`finishedAt`), `durationMs`, `phases[].durationMs`,
metric numeric **values** (not keys), `thresholds[].actual` and `.passed`,
generated ids (`runId`, `appUrl`, `details.windowId`, `details.tableId`,
`details.tableName`, `details.viewId`, `details.fields[].id`,
`details.verifiedSamples[].recordId`), seed cache keys
(`details.seed.cache.seedHash`/`seedHashShort`/`seedTableName`), and the whole
`details.observability` subtree.

**RED FLAG — these are semantic and must NEVER be masked** (if the mask drops any
of them, the tool can hide a regression → FAIL):

- metric **keys** (the set of metric names),
- `phases[].name` and their order,
- `thresholds[].metric` / `.max` / `.unit`,
- `details.operation`,
- **`details.replaySetup`** — its keys, including presence vs absence,
- routing fields `engine` / `engineMatched` / `routeMatched` / `feature` /
  `xTeableV2` / `xTeableV2Reason`,
- `details.verifiedSamples[].expected`, `details.rowCount`, `details.batchSize`.

**Independent re-derivation** (don't trust codex's mask list at face value): run
`main` twice into two dirs and diff the two same-code artifacts by eye (or with
`diff <(jq -S . a.json) <(jq -S . b.json)`). The fields that differ between two
identical runs are _exactly_ the legitimately maskable set above. If anything
else differs run-to-run, investigate before trusting the tool.

## 8. Golden reference — what each artifact must contain

Independent of the diff tool, the candidate artifacts must match these shapes
(observed from a verified Part B run; numeric values vary, everything below does
not). Use this as a second, tool-independent check.

**record-delete-delete-1k** — `operation: "delete"`

- metric keys: `prepareMs, seedCacheHit, seedCacheEnabled, seedReadyMs, delete1kMs`
- threshold: `delete1kMs` max `30000` unit `ms`
- phases: `prepare → seedReady → delete1kMs → verifyDeleted`
- `details.replaySetup`: **absent (undefined)** ← the key Part B trap; must NOT be `{}`
- `details.verifiedSamples`: empty
- routing v1: `xTeableV2:"false", reason:"disabled", feature:"deleteRecord"`;
  routing v2: `xTeableV2:"true", reason:"env_force_v2_all", feature:"deleteRecord"`

**record-undo-delete-1k** — `operation: "undo"`

- metric keys: `… seedReadyMs, deleteSetup1kMs, deleteSetupVerifyMs, undoReplay1kMs`
- threshold: `undoReplay1kMs` max `90000`
- phases: `prepare → seedReady → deleteSetup1k → deleteSetupVerify → undoReplay1kMs → verifyRestored`
- `details.replaySetup` keys: `deleteSetup1kMs, deleteSetupVerifyMs`
- `details.verifiedSamples`: 3 entries
- routing: v1 `engine:"v1"`; v2 `engine:"v2", commandTypes:["RestoreRecords"], commandCount:1000, engineMatched:true`

**record-redo-delete-1k** — `operation: "redo"`

- metric keys: `… deleteSetup1kMs, deleteSetupVerifyMs, undoSetup1kMs, undoSetupVerifyMs, redoReplay1kMs`
- threshold: `redoReplay1kMs` max `90000`
- phases: `prepare → seedReady → deleteSetup1k → deleteSetupVerify → undoSetup1k → undoSetupVerify → redoReplay1kMs → verifyDeleted`
- `details.replaySetup` keys: `deleteSetup1kMs, deleteSetupVerifyMs, undoSetup1kMs, undoSetupVerifyMs`
- `details.verifiedSamples`: empty
- routing: v1 `engine:"v1"`; v2 `engine:"v2", commandTypes:["DeleteRecords"], commandCount:1000`

Quick extraction per file:

```bash
node -e 'const d=require(process.argv[1]);console.log(d.details.operation,
Object.keys(d.metrics), d.phases.map(p=>p.name),
d.details.replaySetup?Object.keys(d.details.replaySetup):"undefined",
JSON.stringify(d.details.routing))' <artifact>.json
```

## 9. Cleanup

```bash
git worktree remove /tmp/plab-main --force
git worktree remove /tmp/plab-cand --force
```

Leave `teable-ee` and the sandbox as you found them; do not commit injected
files or local artifacts.

## 10. Report (deliverable)

In plain language for the owner:

- **PASS/FAIL per section**: A (scope+static), B (registry indirection),
  C (live v1/v2 run), D (G1 diff + perturbation), E (mask), 8 (golden shapes).
- **The judgment calls**, especially the Section E mask verdict and the Section
  D perturbation result — state what you saw and what you concluded.
- **One-line recommendation:** `merge` / `fix-then-merge` (list the exact fixes)
  / `reject`.

Reminder: a green `pnpm check` is never sufficient. The live v1/v2 run + a G1
diff from a _trustworthy_ (un-over-masked, fail-capable) comparator is the
behavioral proof.
