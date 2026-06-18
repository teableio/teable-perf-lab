# Spec 1 — Runner registry + lifecycle driver (skeleton) + G1 artifact-diff guardrail

> Self-contained task spec. The implementing agent can start cold from this file.
> This is **phase 1 of 4** in an incremental deepening of the perf-case runner
> framework. Do **not** attempt the whole refactor — implement exactly this slice.

## Why this exists (read first)

Today every `framework/runners/*.runner.ts` re-implements the same lifecycle by
hand: prepare/seed → seedReady → optional setup phases → the one measured
operation (trace-wrapped) → verify → assemble `PerfRunResult` (built twice, once
in the `catch` as a `PerfRunDiagnosticError`, once on success) → `finally`
cleanup. The dispatch is also duplicated across two 35–40 arm switches
(`framework/run-perf-case.ts` and `framework/run-perf-seed.ts`), and the runner
kind/config unions in `framework/types.ts`. Adding or changing a runner means
touching all of these by hand, and the protocol lives only in prose under
`.agents/`.

The owner is not a hands-on developer: they dispatch agents to write code and
must **trust the result without reading the diff**. So this slice optimizes for
two things only:

1. **AI-navigability** — a runner should declare the few things that vary, not
   re-type the whole protocol.
2. **Trustworthy-by-construction** — every step must be provable by a command,
   not by code review. This slice ships its own proof (guardrail **G1**).

Background to read before coding: `README.md` (project map + execution model),
`.agents/README.md`, `.agents/new-runner-contract.md`, `.agents/seed-execute.md`
(the A/B/C/D cleanup taxonomy), and `.agents/skills/localrun/SKILL.md` (local
v1+v2 verification). Hard rules still apply: keep changes inside this repo, do
**not** edit `../teable-ee`, run `pnpm check` before finishing.

## Goal of this slice

- Collapse the two dispatch switches into **one runner registry** that maps a
  `PerfRunnerKind` to its `{ execute, seed }` entry. Legacy and migrated runners
  coexist in the same table.
- Introduce a **lifecycle driver** that owns the repeated control flow
  (measure/trace orchestration, `try/catch` → diagnostic result, `finally` →
  cleanup) so a runner declares only its variable parts.
- **Migrate exactly one family** — `record-delete`, `record-undo`,
  `record-redo` — onto the driver as the worked example that proves the driver
  is real (an interface with zero users proves nothing).
- Ship **G1**, an artifact-diff tool + procedure that proves the migration did
  **not** change observable behavior.

## Explicit non-goals (do NOT do these here)

- Do **not** migrate any other runner family. The other ~37 runners stay exactly
  as they are, dispatched through the registry's legacy entries.
- Do **not** unify `PerfRunResult` assembly across families. Each family keeps
  its own result builder (here: `buildRecordReplayResult`). Generic result
  assembly is a later phase.
- Do **not** rename or split `record-undo-redo.shared.ts` (that misleading-name
  cleanup is a separate later phase). The driver **calls into** the existing
  shared helpers unchanged.
- Do **not** change `framework/types.ts` config interfaces, case ids,
  `registry.ts`, any `cases/**`, or the artifact JSON schema.
- Do **not** add the other guardrails (contract-conformance, routing/verify,
  registry/readme consistency). Those are Specs 2–4.

## Part A — Runner registry (pure indirection, zero behavior change)

Create `framework/runner-registry.ts` exporting one table:

```ts
// shape — refine names during implementation
export type ExecuteEntry = (
  c: PerfCase,
  ctx: PerfRunContext,
) => Promise<PerfRunResult>;
export type SeedEntry =
  | ((c: PerfCase, ctx: PerfRunContext) => Promise<PerfRunResult>)
  | { seedless: "no reusable seed phase"; reason: string }; // for http-endpoint/record-paste/table-create

export const runnerRegistry: Record<
  PerfRunnerKind,
  {
    execute: ExecuteEntry;
    seed: SeedEntry;
  }
> = {
  /* one entry per kind */
};
```

Then:

- `framework/run-perf-case.ts`: replace the `runCaseByKind` switch with a table
  lookup (`runnerRegistry[perfCase.runner].execute`). Keep the unsupported-kind
  `throw` for an unknown key.
- `framework/run-perf-seed.ts`: replace the `seedCaseByKind` switch with a table
  lookup. The current `record-delete | record-undo | record-redo` arm calls
  `seedRecordUndoRedoCase(perfCase, context, perfCase.runner)`; preserve that
  exact call by giving those three kinds a seed entry that forwards
  `perfCase.runner`. Preserve the `skipped` result object for `http-endpoint`,
  `record-paste`, `table-create` byte-for-byte (same `result`, `metrics`,
  `thresholds`, `details`).

**Constraint:** Part A is pure indirection. For every kind, the registry entry
must call the **same function with the same arguments** the switch did. No
observable change. Proof: `pnpm check` (types + format) stays green, and a local
run of `smoke/auth-user` plus one record case produces identical artifacts.

## Part B — Lifecycle driver + migrate the delete/undo/redo family — ALREADY DONE (worked example)

> **Status: implemented as the sample. Do not redo it — study it and follow the
> same pattern for the rest.** Files:
> `framework/runners/record-replay-lifecycle.ts` (the driver),
> `framework/runners/record-delete.runner.ts`,
> `framework/runners/record-undo.runner.ts`,
> `framework/runners/record-redo.runner.ts` (all three migrated and thin).
> `pnpm check` is green; runtime verification (G1) is still pending — see Part C.

### What was built (and a deliberate deviation from the sketch above)

The original sketch proposed a generic `framework/run-lifecycle.ts` with a
universal `LifecycleModule<TFixture>`. The sample deliberately did **not** build
that. Reason (design-it-twice / "one example = a guess, two = a real seam"):
designing a universal driver from a single family is premature generality and a
misleading name. Instead the driver is named for what it actually is and stays
record-replay-family-shaped until a second family proves the general shape.

- `framework/runners/record-replay-lifecycle.ts` exports
  `runRecordReplayLifecycle(perfCase, context, spec)` and the `RecordReplaySpec`
  contract. It owns, exactly once, the skeleton all three runners used to
  hand-write: `prepare` (seed) → `seedReady` → optional `runSetup` →
  the measured op (inside `withRecordWindowId` + `withPerfTraceStep` +
  `measureAsync(config.threshold.metric)`) → `verify` → `buildRecordReplayResult`
  (called for both the success and the `catch`/diagnostic path) → `finally`
  cleanup via `cleanupRecordUndoRedoFixture`.
- A runner now declares only what varies, via `RecordReplaySpec`:
  `runner`, `operation`, `seedCodeFile`, optional `runSetup`,
  `measuredOperation`, `verifyPhaseName`, `verify`.

| Spec field          | delete                            | undo                                        | redo                                      |
| ------------------- | --------------------------------- | ------------------------------------------- | ----------------------------------------- |
| `runSetup`          | omitted                           | delete + deleteVerify                       | delete + deleteVerify + undo + undoVerify |
| `measuredOperation` | `deleteAllRowsViaSelectionDelete` | `undoLastOperation`                         | `redoLastOperation`                       |
| `verify`            | `assertDeleted`                   | `waitForRowsRestored({verifySamples:true})` | `assertDeleted`                           |
| `operation`         | `"delete"`                        | `"undo"`                                    | `"redo"`                                  |

Behavior-preservation detail worth knowing when verifying: `record-delete` must
pass `setupMeasurements: undefined` (not `{}`) to `buildRecordReplayResult` so
`details.replaySetup` stays `undefined` exactly as before. The driver does this
by only creating the bag when `spec.runSetup` exists.

`record-undo-redo.shared.ts` and `buildRecordReplayResult` are unchanged; the
seed path (`seedRecordUndoRedoCase`) is unchanged; runner export names are
unchanged, so `run-perf-case.ts` still works without edits.

## Part C — Guardrail G1: artifact-diff proof

Create `scripts/diff-artifacts.mjs` (mirror the style of
`scripts/check-trace-classification.mjs`: plain Node, `node:assert`, prints an
ok/fail line, sets `process.exitCode`). It takes two perf artifact JSON files
(baseline vs candidate for the same `caseId`+`engine`), **masks volatile
fields**, and deep-equals the remainder. Any surviving difference is a real
behavior change and must fail.

**Volatile fields to mask** (replace with a placeholder; do not compare values):

- timing/timestamps: `durationMs`, `startedAt`, `finishedAt`,
  `phases[].durationMs`, `metrics.*` numeric values (compare metric **keys**,
  not values), `thresholds[].actual`, `thresholds[].passed`.
- generated ids: `runId`, `appUrl`, `details.windowId`, `details.tableId`,
  `details.tableName`, `details.viewId`, `details.fields[].id`,
  `details.verifiedSamples[].recordId`.
- seed cache keys (change when the runner file content changes — expected):
  `details.seed.cache.seedHash`, `seedHashShort`, `seedTableName`.
- the entire `details.observability` subtree (trace fetch is runtime/noisy);
  compare only that the key is present.

**Compare and require identical:** `caseId`, `title`, `result`, `engine`,
metric **keys** (the set, not values), `thresholds[].metric/max/unit`,
`phases[].name` (and their order), and the **structural shape of `details`**
(same keys, same nesting, same non-volatile leaf values such as
`details.operation`, `rowCount`, `batchSize`, routing assertion keys,
`verifiedSamples[].expected`).

**Method to derive the mask empirically (put this in the script's header doc and
the verification steps):** run the _unmigrated_ case **twice** in the same
environment first; diff the two baseline artifacts; everything that differs
between two identical-code runs is volatile and belongs in the mask. After
migration, a clean diff against a masked baseline means behavior is preserved.

## Verification (the proof the owner relies on)

Run in order; all must pass:

1. `pnpm check` — green (format, yaml, ts-syntax, ts-types, trace, cases,
   readme). This proves Part A/B did not break types or the existing checks.
2. Local v1+v2 run of the migrated family using `.agents/skills/localrun`
   (representative case: `record-undo/delete-1k`, and at least also
   `record-delete/delete-1k`). Capture artifacts.
3. G1 proof for each migrated case + engine:
   - On `main` (pre-change): run the case twice → `baseline-a.json`,
     `baseline-b.json`. `node scripts/diff-artifacts.mjs baseline-a.json
baseline-b.json` must pass (this validates/locks the mask).
   - On the branch (post-change): run the case → `migrated.json`.
     `node scripts/diff-artifacts.mjs baseline-a.json migrated.json` must pass.
     Do this for both `v1` and `v2`.
4. Inspect the migrated artifacts by eye for `details.routing`,
   `details.seed` (cache enabled/hit/reusable), and `observability.traces`
   presence — confirm they are still emitted.

## Acceptance checklist

- [x] **(done)** `framework/runners/record-replay-lifecycle.ts` owns the
      try/catch→diagnostic + finally→cleanup + measure/trace skeleton once.
- [x] **(done)** `record-delete/undo/redo` runners are driver-based and declare
      only their variable hooks; `record-undo-redo.shared.ts` and
      `buildRecordReplayResult` are unchanged.
- [x] **(done)** `pnpm check` green (static: ts, types, trace, cases, readme).
- [ ] **(codex)** `framework/runner-registry.ts` is the single dispatch source;
      both `run-perf-case.ts` and `run-perf-seed.ts` look up the table; the two
      switches are gone (Part A).
- [ ] **(codex)** Unmigrated kinds behave identically (same functions, same
      args; seed `skipped` objects byte-identical).
- [ ] **(codex)** `scripts/diff-artifacts.mjs` exists; two-baseline diff passes;
      pre/post migration diff passes for all three cases × v1 + v2 (Part C).
- [ ] **(codex)** local v1+v2 run green for the migrated family.

## Compatibility constraints (restate before editing)

- Artifact JSON schema unchanged. `metrics`, `phases`, `details.seed`,
  `details.routing`, `observability.traces` keep the same shape and the same
  non-volatile values.
- Case ids, thresholds, `registry.ts`, `cases/**`, `framework/types.ts` config
  interfaces: untouched.
- Pre-existing untracked files (`.DS_Store`, `tasks/v2-trace-bsp-drop-blocker.md`)
  are unrelated — do not delete or revert them.

## Follow-on specs (context only — not in scope here)

- Spec 2 — G2 contract-conformance check (runner declares required hooks;
  threshold metric matches config) wired into `pnpm check`.
- Spec 3 — G3 routing/verify silent-error guards (feature mismatch throws at the
  ~10 call sites passing `feature:`; verification proves values, not just 200).
- Spec 4 — G4 Case Catalog read module + extend disk/registry consistency to
  `check:readme`; outputs byte-stable.
- Ongoing — each future agent task migrates the one runner it touches onto the
  driver (boy-scout), guarded by G1–G4.
