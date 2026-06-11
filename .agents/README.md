# Agent Playbook: Add A Perf Case

You are helping someone add a Teable performance regression case. They may know
the product feature they want to measure but not this repo. Drive the flow; do
not make them learn the internals first.

Read this file top to bottom, then pull in the other files only when a step
needs them:

- [runners.md](runners.md) — pick which runner expresses the case.
- [case-spec.md](case-spec.md) — the spec you draft and confirm before coding.
- [checklist.md](checklist.md) — hard rules to honor while writing code.
- [seed-execute.md](seed-execute.md) — seed vs execute boundary and caching.
- [examples.md](examples.md) — standard case index by behavior.
- [case-trace-fix-agent.md](case-trace-fix-agent.md) — diagnose and fix cases
  flagged as `Trace 缺失` by the performance monitor.
- [new-runner-contract.md](new-runner-contract.md) — required wiring and
  artifact/trace/seed contracts when a new runner is unavoidable.
- [skills/localrun/SKILL.md](skills/localrun/SKILL.md) — local `teable-ee`
  sandbox refresh, perf-lab injection, runtime smoke checks, GitHub Actions
  acceptance, and trace artifact diagnosis.

## The Flow

```text
intake -> draft spec -> confirm -> pick runner -> write -> register -> check
       -> local verify -> summarize
```

The deliverable is not "files that pass `pnpm check`". It is a case that has
**passed a local v1+v2 runtime run with verified artifacts**, plus a summary
the user can read without opening any code.

### 1. Intake

Accept partial input. The user usually gives only some of:

- **Real Scenario**: the product action being measured (e.g. "clear all cells in
  a 10k-row grid").
- **Seed Phase**: what data must exist first (table shape, row count, fields).
- API / interface notes: endpoint, payload shape, headers.

If the API notes are enough to draft a spec, do **not** go search product code
first. Only inspect `framework/runners/*.runner.ts` or the product when you are
genuinely blocked on how an operation behaves.

If the user asks for "the next case" without naming an operation, look for
v1/v2-differentiated operations in `../teable-ee`: the canary feature list is
`v2FeatureSchema` in
`community/packages/openapi/src/admin/setting/update.ts`, and each feature is
marked on its controller with `@UseV2Feature('<name>')`. Compare that list
against `cases/` groups; an uncovered feature with a real v2 implementation is
a strong candidate. Prefer heavy operations (rewrites many cells, recomputes
dependencies) and read paths that are not yet measured.

### 2. Draft Spec

Fill the missing parts yourself using [case-spec.md](case-spec.md). Mark every
inferred field as an assumption. The user confirms or corrects; they should not
have to write the spec.

### 3. Confirm

Show the spec. Wait for the user to approve. Ask a question only when a missing
answer would change the implementation (see "Ask only when blocked" below).

Exception: when the user asked for end-to-end delivery ("write it, verify it,
give me a summary") or is not available to answer, do not block on
confirmation. Proceed with sensible defaults, label every inferred value as an
assumption, and repeat the spec plus its assumptions in the final summary so
the user can correct them after the fact.

### 4. Pick Runner

Use [runners.md](runners.md). Decision order:

```text
reuse existing runner -> extend a runner -> new runner
```

Prefer reuse. Extend only when no current runner can express the case. Create a
new runner only when extending would distort an existing runner's behavior. If a
new runner is unavoidable, follow [new-runner-contract.md](new-runner-contract.md).

### 5. Write

Two files, same base name:

```text
cases/<group>/<case-name>.case.ts   # executable config, via definePerfCase()
cases/<group>/<case-name>.md         # description (frontmatter + sections)
```

`.case.ts` rules:

- `id` must equal the path: `cases/formula/10k-calc.case.ts` -> `formula/10k-calc`.
- Never rename an existing `id` unless you intend a new Teable registry row and a
  new history group.
- Keep data deterministic and row counts fixed so V1/V2 and reruns compare.

`.md` rules: start with frontmatter (`owner`, `tags`, `enabled`), then the
sections `Goal`, `Seed Phase`, `Execute Phase`, `Primary Metric`, `Notes`. Use
[examples.md](examples.md) to find the closest existing case, then copy the
shape from that case's markdown.

### 6. Register

In `registry.ts`: add the import and include the case in the `cases` array.
Optionally add short aliases in `caseAliases` for manual triggering, but keep
aliases current and literal. Do not map old workload names such as `*/10k` to a
new `*/1k` case. An unregistered `.case.ts` fails the case check.

### 7. Check

```bash
pnpm check
```

This validates formatting, workflow YAML, TypeScript syntax, and case registry
(every case registered, exists on disk, has a same-name markdown, and parses the
metadata Teable sync needs). It does **not** execute anything against a real
Teable — that is step 8.

### 8. Local Verify

Follow [skills/localrun/SKILL.md](skills/localrun/SKILL.md) for the exact
commands (sandbox refresh, perf-lab injection, Docker prerequisites, the
vitest invocation). The short version:

```bash
.agents/skills/localrun/scripts/refresh-teable-ee-sandbox.sh
.agents/skills/localrun/scripts/inject-perf-lab.sh
# then run the case from the sandbox with PERF_LAB_ENGINE_LIST=v1,v2
```

A run is verified only when you have checked the artifact JSON
(`$PERF_LAB_ARTIFACT_DIR/<case>-<engine>.json`), not just the vitest exit
code. Minimum evidence per engine:

- `result` is `pass`.
- `details.routing.routeMatched` is `true` and `x-teable-v2` matches the
  requested engine (for cases that assert routing).
- Verification evidence is complete: full scan `scannedRecords` equals the
  configured row count, or the equivalent final-state proof for the case.
- Metrics are sane: the primary metric exists and is well under `maxMs`
  (local runs should not sit near the threshold).

Common first-run failures and fixes live in the skill file (missing
dependency after sandbox refresh → `pnpm install`; Prisma enum errors →
`make switch-db-mode`). If a run fails, fix the case or runner, re-run
`pnpm check`, re-inject, and re-run until both engines pass. Do not hand back
a case that has never executed.

### 9. Summarize

End with a summary the user can act on without reading code:

- What the case measures, in one product-level sentence per case.
- A small table: case x engine -> pass/fail and the primary metric value.
- Routing evidence (`x-teable-v2-feature`, route matched) when relevant.
- Every assumption you made, especially the initial `maxMs` guardrail and row
  counts, and what should be tightened after real CI history.
- Files added/changed, and the GitHub Actions command for official acceptance
  (see [../docs/operations/teable-ee-e2e.md](../docs/operations/teable-ee-e2e.md)).

## Ask Only When Blocked

Proceed on sensible defaults and label them as assumptions. Ask the user only
when the answer changes what you build — for example a row count that decides
which stream path the product takes, or a metric the case is allowed to count.

## Running In CI (optional)

Local `pnpm check` does not execute the case against a real Teable. To get real
timings, the user runs it through GitHub Actions. The trigger command and all
workflow inputs live in
[../docs/operations/teable-ee-e2e.md](../docs/operations/teable-ee-e2e.md) — do
not duplicate them here.

After a push to `main`, `Sync perf cases` mirrors case metadata into the Teable
`Perf Cases` table automatically.
