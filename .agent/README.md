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

## The Flow

```text
intake -> draft spec -> confirm -> pick runner -> write -> register -> check
```

Do not skip "confirm". Do not start `pnpm check` until files exist.

### 1. Intake

Accept partial input. The user usually gives only some of:

- **Real Scenario**: the product action being measured (e.g. "clear all cells in
  a 10k-row grid").
- **Seed Phase**: what data must exist first (table shape, row count, fields).
- API / interface notes: endpoint, payload shape, headers.

If the API notes are enough to draft a spec, do **not** go search product code
first. Only inspect `framework/runners/*.runner.ts` or the product when you are
genuinely blocked on how an operation behaves.

### 2. Draft Spec

Fill the missing parts yourself using [case-spec.md](case-spec.md). Mark every
inferred field as an assumption. The user confirms or corrects; they should not
have to write the spec.

### 3. Confirm

Show the spec. Wait for the user to approve. Ask a question only when a missing
answer would change the implementation (see "Ask only when blocked" below).

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
metadata Teable sync needs). Run it before you finish.

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
