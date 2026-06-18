# Runner Framework Plan

This is the durable plan for runner-framework work. It is written for agents.

Use it to answer four questions before changing code:

1. What must not change?
2. Which framework surface is allowed to change?
3. What is the smallest valid change?
4. What proof makes the change acceptable?

Do not use this as a PRD, background essay, or case-authoring guide. Concrete
implementation tasks still need their own task spec. Case-authoring rules stay
in `.agents/`.

## First Principles

1. A perf case is a behavioral contract.
   The stable contract is its case id, runner kind, seed shape, measured
   operation, thresholds, verification evidence, routing evidence, and artifact
   semantics.

2. Seed and execute are separate stages.
   Seed may prepare reusable deterministic fixtures. Execute must run the fresh
   measured operation after the fixture is ready.

3. Artifact JSON is the behavior proof.
   Source checks prove the code still compiles and contracts are wired.
   Artifacts prove the runner still did the same thing.

4. Framework code should own protocol, not case semantics.
   Shared dispatch, lifecycle orchestration, trace wrapping, diagnostic result
   construction, cleanup policy, and validation checks belong in `framework/`.
   Product workload decisions stay in the case config and runner-specific hooks.

5. Refactor by runner kind.
   A runner kind owns all cases that use it. Migrating one file while leaving
   sibling cases unverified is not a complete framework change.

6. Add generality only after the second real example.
   The first migrated family may justify a family-shaped driver. A universal
   driver is only justified when at least two runner families prove the common
   shape.

## Protected Surface

Do not change these during a framework refactor unless the task explicitly says
the case contract itself is changing:

- case ids
- `cases/**`
- `registry.ts`
- artifact JSON schema in `framework/artifacts.ts`
- runner config interfaces in `framework/types.ts`
- thresholds, primary metrics, row counts, batch sizes, and sample expectations
- semantic artifact fields such as operation names, phase names, routing fields,
  replay setup keys, and verification details
- adjacent checkouts such as `../teable-ee`

If a task only claims to improve the framework, any change to the protected
surface is a red flag.

## Allowed Framework Surfaces

### 1. Registry Dispatch

Goal: one dispatch table maps each `PerfRunnerKind` to `{ execute, seed }`.

Rules:

- One table entry per runner kind, no more and no less.
- Execute and seed callers look up the table; they do not keep runner switches.
- Legacy entries call the exact same functions with the exact same arguments as
  the old switch arms.
- Seedless entries return the same skipped result shape every time.
- Unknown runner values still fail loudly.
- Adding a runner kind without a registry entry fails source validation.

Proof:

- `pnpm check` passes.
- Execute and seed dispatch files contain no runner switch.
- Registry coverage matches the `PerfRunnerKind` union exactly.
- For pure dispatch changes, old switch arms and registry entries are equivalent:
  same kind, same function, same arguments, same skipped result objects.
- Run at least one seedful runner and one seedless runner when the dispatch
  surface changes.

### 2. Lifecycle Drivers

Goal: move repeated runner protocol into a driver shaped by one runner family.

A driver may own:

- seed readiness checks
- optional setup phases
- measured operation wrapping
- trace step boundaries
- verification call ordering
- diagnostic result construction
- cleanup ordering and isolated-DB short circuit

A migrated runner declares only what varies for that family.

Rules:

- Migrate one runner kind or one tightly-coupled runner family per task.
- Before migrating, list every case using the affected runner kind.
- Keep legacy runners legacy when the family shape is not clear.
- Write a new family-shaped driver when an existing driver does not fit.
- Do not turn the first family driver into a universal abstraction by naming
  alone.

Proof:

- `pnpm check` passes.
- Every case using the migrated runner kind runs on every relevant engine.
- G1 artifact diff passes for baseline vs candidate for every case and engine.
- Artifacts still include seed, routing, verification, phase, metric, threshold,
  and trace evidence.
- `tasks/runner-migration-tracker.md` is updated.

### 3. G1 Artifact Diff

Goal: prove framework refactors preserve observable behavior.

The comparator may mask only values that differ between two runs of unchanged
code:

- timestamps and durations
- metric numeric values, while keeping metric keys
- threshold `actual` and `passed`, while keeping metric, max, and unit
- generated ids
- seed hash identifiers
- the trace observability subtree

The comparator must compare semantic fields:

- case id, title, result, engine
- metric key set
- phase names and order
- threshold metric, max, and unit
- operation name
- replay setup presence and keys
- routing engine, engineMatched, routeMatched, and feature
- verified sample expected values
- row count and batch size

Proof:

- Baseline vs baseline passes for two unchanged-code runs.
- Baseline vs candidate passes for every touched case and engine.
- A deliberate semantic perturbation fails.
- The mask list is derived from actual run-to-run noise, not from expected
  candidate differences.

### 4. G2 Contract Checks

Goal: make source-level framework contract drift fail in `pnpm check`.

Target failures:

- runner kind exists but has no registry entry
- registry entry exists but runner kind does not
- primary threshold metric cannot be produced by the runner
- migrated runner misses a required lifecycle declaration
- seed entry shape is invalid

Proof:

- The check is part of `pnpm check`.
- Negative fixtures or inline assertions prove each contract violation fails.
- The check focuses on framework contracts, not private implementation style.

### 5. G3 Routing And Verification Guards

Goal: make silent false positives fail.

Target failures:

- expected engine does not match actual engine
- expected feature route does not match actual feature route
- a case verifies only request success but not final state
- verification evidence is missing from the artifact

Proof:

- Guards are placed at the highest shared routing/verification surface.
- Affected runtime cases run on v1 and v2 when route behavior matters.
- Artifacts include route-match evidence and final-state evidence.

### 6. G4 Case Catalog

Goal: make registry, README, and sync tooling read from one catalog shape.

Target failures:

- case file exists but is not registered
- registry imports a missing case file
- case markdown is missing
- README generated case list is stale
- generated output changes when it should be byte-stable

Proof:

- `pnpm check` catches registry, disk, and README drift.
- Existing generated README output stays byte-identical for the first catalog
  refactor.
- At least one negative path proves missing registry or missing markdown is
  caught.

## Agent Work Order

For any runner-framework task:

1. Identify the allowed framework surface from this document.
2. Check `tasks/runner-migration-tracker.md` before touching lifecycle code.
3. Enumerate every affected runner kind and case id.
4. Capture the baseline proof required for the change type.
5. Make the smallest framework-only change.
6. Run `pnpm check`.
7. Run the required runtime/artifact proof.
8. Update tracker/docs only when the source of truth changed.

Stop and narrow the task if it touches multiple unrelated surfaces.

## Verification Matrix

| Change type                   | Required proof                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Registry-only dispatch change | `pnpm check`; switches removed; registry calls same functions with same args     |
| Lifecycle migration           | `pnpm check`; all cases for runner kind run; G1 baseline vs candidate passes     |
| G1 comparator change          | unchanged-code diff passes; semantic perturbation fails                          |
| Contract check change         | `pnpm check`; negative cases prove each contract violation fails                 |
| Routing/verification guard    | `pnpm check`; affected cases run; artifacts show route and final-state evidence  |
| Case catalog refactor         | `pnpm check`; generated output byte-stable; registry/disk/README drift is caught |

## Done Definition

A framework task is done only when:

- it changes one bounded framework surface
- protected case behavior and artifact schema stay stable
- `pnpm check` passes
- required runtime/artifact proof passes
- comparator or guardrail fail-tests pass when applicable
- review output can state PASS/FAIL with concrete evidence

Green source checks alone are not runtime acceptance.
