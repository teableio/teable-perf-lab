# Spec: duplicateBase / createTable / deleteTable / restoreTable perf cases

## Implementation status (2026-06-12) — READ THIS FIRST

The implementation is **done** and `pnpm check` passes. What remains is step 8
(local runtime verify on v1+v2) and any runtime fixes. If you are the
verifying agent, your job is:

1. Follow `.agents/skills/localrun/SKILL.md`: refresh the sandbox, inject
   perf-lab, then run each case with `PERF_LAB_ENGINE_LIST=v1,v2`:
   `duplicate-base/10k-3tables-link-2workflow`,
   `table-create/10x-20f-no-records`, `table-delete/10k-20f`,
   `table-restore/10k-20f`.
2. Check artifact JSON per engine per the Acceptance section at the bottom.
3. Fix runner/case code on failure, re-run `pnpm check`, re-inject, repeat.

Files delivered (group names ended up `table-*`, runner kinds match):

- `framework/types.ts` — 4 runner kinds + `DuplicateBaseCaseConfig`,
  `TableCreateCaseConfig`, `TableDeleteCaseConfig`, `TableRestoreCaseConfig`.
- `framework/runners/duplicate-base.runner.ts`
- `framework/runners/table-create.runner.ts`
- `framework/runners/table-delete.runner.ts`, `table-restore.runner.ts`,
  `table-lifecycle.shared.ts` (shared archive/trash/sample helpers; seed
  reuses `prepareRecordUndoRedoFixture`).
- `framework/runners/record-undo-redo.shared.ts` — `getExpectedCellValue`
  and `buildRecordFields` are now exported (no behavior change; the file
  content change invalidates record-delete/undo/redo seed caches once).
- `framework/run-perf-case.ts`, `framework/run-perf-seed.ts`, `registry.ts`,
  README Available Cases, 4 case files + 4 same-name md files.

Runtime-risk assumptions to validate first when something fails:

- `records: []` in `POST /base/{baseId}/table` creates **zero** records
  (duplicate-table's seed relies on the same behavior; table-create verifies
  emptiness).
- Link cell write payload `{ id: recordId }` with `typecast: true` on a
  many-one link field (duplicate-base linked table seeding).
- Link cell read value is `{ id, title }` and `title` equals the main row's
  `Title` value (duplicate-base link sample checks).
- `GET /trash/items` response carries `nextCursor` for pagination
  (table-lifecycle `findTableTrashId`; only matters when the base trash holds
  more than one page).
- `POST /trash/restore/{trashId}` returns 200/201 and carries
  `x-teable-v2-feature: restoreTable` headers.
- `getBaseList({ spaceId })` returns an array of `{ id, name }`
  (duplicate-base cache lookup).
- Workflow endpoints (`POST/GET /base/{baseId}/workflow`) are EE module
  routes; both seeding and verification degrade gracefully when absent —
  artifact `details.workflows.available` records which path ran.
- `permanentDeleteBase` works on a live (non-trashed) base (verified in
  service code; re-check only if cleanup fails).

The original spec below is kept for context and acceptance criteria.

---

Handoff spec for an implementing agent. Read `.agents/README.md` first and
follow its flow (`write -> register -> check -> local verify -> summarize`).
This document is the confirmed case spec (steps 1–4 of that flow are done);
your job is steps 5–9. Everything marked **ASSUMPTION** was inferred and may be
corrected by the user after delivery — implement as written unless it is
impossible, and report deviations in your summary.

All four target operations are v2 canary features (see `v2FeatureSchema` in
`community/packages/openapi/src/admin/setting/update.ts` of `teable-ee`):
`duplicateBase`, `createTable`, `deleteTable`, `restoreTable`. None of them is
covered by an existing case group. Closest existing work: the
`duplicate-table` runner (`framework/runners/duplicate-table.runner.ts`) and
its cases `cases/duplicate-table/10k-20f.*` — copy its shapes (seed builder,
trace steps, verification, cleanup, artifact details) wherever possible.

## Verified product facts (do not re-derive; cite paths if you must re-check)

- `POST /api/base/duplicate` — body `duplicateBaseRoSchema`
  (`packages/openapi/src/base/duplicate.ts`): `{ fromBaseId, spaceId,
withRecords?, name?, nodes? }`. Returns `ICreateBaseVo` (the new base).
  Controller: `features/base/base.controller.ts` `@UseV2Feature('duplicateBase')`.
  There is also a `POST /api/base/duplicate-stream` SSE variant — we measure
  the **synchronous** endpoint.
- `POST /api/base/{baseId}/table` — body `tableRoSchema`
  (`packages/openapi/src/table/create.ts`), may include `fields[]`, `views[]`,
  `records[]` (records use `createRecordsRoSchema.shape.records`; verify the
  per-request record cap before choosing the inline record count).
  Controller: `features/table/open-api/table-open-api.controller.ts`
  `@UseV2Feature('createTable')`.
- `DELETE /api/base/{baseId}/table/{tableId}` — archive to trash (soft
  delete). `@UseV2Feature('deleteTable')`. V1 path soft-deletes table, fields,
  views in one transaction and runs `detachLink` first.
  `DELETE .../table/{tableId}/permanent` also exists (same feature gate); we
  measure the **archive** route because it is the UI path.
- Restore: `POST /api/trash/restore/{trashId}` (`features/trash/trash.controller.ts`).
  `trashId` is the trash row id, obtained from
  `GET /api/trash/items?resourceType=base&resourceId={baseId}` — find the item
  whose `resourceId` equals the deleted tableId. The v2 decision is made
  per-request in `prepareRestoreTableCanary` and the response carries
  `x-teable-v2` / `x-teable-v2-feature: restoreTable` / `x-teable-v2-reason`
  headers. Note: ids starting with the Operation prefix skip the v2 decision —
  always use the trash item id from `/api/trash/items`.
- The e2e harness exposes `globalThis.testConfig.spaceId` and
  `globalThis.testConfig.baseId` (`apps/nestjs-backend/vitest-e2e.setup.ts`).
  The duplicate-table runner reads `globalThis.testConfig.baseId`; the
  duplicate-base runner needs `globalThis.testConfig.spaceId` as well.
- Base duplication copies workflow (automation) and dashboard nodes: node
  collection in `features/base/base-duplicate.service.ts`
  (`collectNodesAndResourceIds`) includes `resourceType === 'workflow'`.
  Workflows can be seeded via `createWorkflow(baseId, { name? })` from
  `packages/openapi/src/automation/workflow/create.ts`
  (`POST /api/base/{baseId}/workflow` family). Only workflow creation is
  exposed in the community openapi package — configuring triggers/actions may
  need EE endpoints; treat full configuration as best-effort (see Case 1).

## Shared seed shape: "mixed 10k x 20f"

Three of the four cases reuse the deterministic 10,000-row, 20-field mixed
table already defined by `cases/duplicate-table/10k-20f.case.ts` (text, long
text, single/multiple select, number, date, checkbox, rating columns; data
generated from the row number). Reuse the seed-builder logic from
`duplicate-table.runner.ts` — extract it into a shared module rather than
copy-pasting 400 lines. Seed hashes include the runner kind, so each runner
gets its own cached fixture table/base; that is expected and fine.

---

## Case 1: `duplicate-base/10k-3tables-link-2workflow`

- **Goal**: Catch regressions in duplicating a base that contains three
  tables (10k mixed main table, 1k table linked to it, 100-row small table)
  plus two automations, with records included. The cross-table link forces
  the id-remapping path that is unique to base-level duplication.
- **Runner**: **new** `duplicate-base` runner, modeled directly on
  `duplicate-table.runner.ts`. New runner is justified: the measured unit is a
  base, not a table, and seed/cleanup operate on base objects.
- **Seed Phase**:
  - Do **NOT** duplicate the shared seed base (`testConfig.baseId`) — it
    accumulates other cases' cached fixture tables, which would make the
    duplicated payload non-deterministic.
  - Create a dedicated source base in `globalThis.testConfig.spaceId`, named
    with the case prefix + seed hash (e.g.
    `perf-duplicate-base-<seedHashShort>`), containing:
    - **Table A (main)**: the mixed 10k x 20f table (reuse the extracted
      duplicate-table seed builder).
    - **Table B (linked)**: 1,000 rows, a few plain fields plus one link
      field to Table A. Link assignments are deterministic: B row `i` links
      to A row `((i * multiplier + offset) % 10_000) + 1` with `multiplier`
      coprime to 10,000 (see Deterministic Data in `.agents/checklist.md`),
      so every link target is locally computable.
    - **Table C (small)**: 100 rows, ~5 plain fields, deterministic values.
    - **2 workflows** created via `createWorkflow(sourceBaseId, { name })`
      with deterministic names (e.g. `perf-wf-1`, `perf-wf-2`).
      **ASSUMPTION**: empty/draft workflows are enough to exercise the
      workflow-node duplication path. Configuring a trigger/action is
      best-effort: do it only if a community/EE openapi helper is available
      in the sandbox; if workflow creation itself fails at runtime, drop
      workflows from the seed, keep the case otherwise intact, and report
      the deviation.
  - Seed cache: the source base is reusable. Discover an existing fixture by
    listing bases in the space (`getBaseList` / space base list API from
    `@teable/openapi`) and matching the name prefix + hash, then validate
    Table A with the same paged full scan duplicate-table uses, plus row
    counts for B and C. On validation failure, permanently delete the stale
    base and rebuild.
- **Execute Phase**:
  1. Ensure seed base ready (cached or fresh), validated.
  2. Measured: `POST /api/base/duplicate` with `{ fromBaseId: <sourceBaseId>,
spaceId: testConfig.spaceId, withRecords: true, name: "<prefix>-copy-<runId>" }`.
     Capture `x-teable-v2*` routing headers.
  3. Resolve the duplicated base id from the response, list its tables, match
     A/B/C by name.
  4. Verify:
     - Table A: sample rows `[0, 4999, 9999]`, then paged full scan
       (1,000/page) — all 10,000 records, all 20 fields correct.
     - Table B: full scan 1,000 rows; for sampled rows assert the link cell
       points at a record **inside the duplicated Table A** (id remap proof:
       linked record id must be a dup-A record id, not a source-A id) and the
       linked record's title matches the locally computed expected value.
     - Table C: row count 100.
     - Workflow list of the duplicated base contains 2 workflows with the
       expected names (skip if workflows were dropped at seed time).
  5. Cleanup (in `finally`, after the `isExecuteDbIsolated()` short-circuit):
     permanently delete the duplicated base
     (`DELETE /api/base/{baseId}/permanent`, helper in
     `packages/openapi/src/base/permanent-delete.ts`). Keep the source base
     cached. Mutation class B (execute only adds objects).
- **Primary Metric**: `duplicateBaseRequestMs` — the `POST /duplicate` request
  duration. **ASSUMPTION**: `maxMs: 180_000` (duplicate-table 10k-20f uses
  120s; this adds two more tables, link remap, and workflow copy).
  `timeoutMs: 900_000`.
- **Verification Metrics** (diagnostic, not primary):
  `duplicateBaseFullScanReadyMs`, `duplicateBaseTotalReadyMs` — mirror the
  duplicate-table naming.
- **Open Assumptions**: sync endpoint (not `duplicate-stream`);
  `withRecords: true`; workflows are draft-only; no lookup/rollup field
  through the link (a computed-field-heavy base is a follow-up case).

## Case 2: `table-create/10x-20f-no-records`

- **Goal**: Catch regressions in schema-side table creation: create 10
  tables, each with 20 mixed fields and one grid view and **no records**,
  sequentially inside a single measured window. Repetition (not record
  volume) amplifies the signal, so the metric stays specific to the
  createTable path instead of being dominated by record insertion (already
  covered by `record-create` cases).
- **Runner**: **new** `table-create` runner. (`field-create` is the closest
  shape — empty-seed, measured create, metadata verify — but it creates a
  field inside an existing table; extending it would distort it.)
- **Seed Phase**: none beyond the shared seed base (`baseId: "seed-base"` in
  config, resolved via `globalThis.testConfig.baseId`). No seed cache — the
  created tables ARE the measured workload (mutation class A, like
  record-paste).
- **Execute Phase**:
  1. Build the deterministic payloads locally: 10 payloads, each the 20-field
     mixed schema above plus one grid view, names
     `<prefix>-<runId>-01 .. -10`, `fieldKeyType: "name"`, and **no
     records**. Try `records: []` first; if the schema rejects an empty
     array, omit `records` and accept the server-generated 3 default empty
     records (constant across runs and engines — record this fallback in the
     artifact details and the case md).
  2. Measured (one timed window, one trace step per request): loop the 10
     `POST /api/base/{baseId}/table` calls sequentially. Capture routing
     headers from each response (`x-teable-v2-feature: createTable`); assert
     all 10 routed to the same engine.
  3. Verify: every response contains a table id; for each created table the
     field list has all 20 fields with expected types and the view list has
     the grid view; record count matches the chosen payload variant (0, or 3
     empty defaults).
  4. Cleanup: permanently delete all 10 created tables
     (`DELETE .../table/{tableId}/permanent`) after the isolated-DB
     short-circuit — including any partial set when the loop failed midway.
- **Primary Metric**: `createTables10xTotalMs` — wall time of the 10-create
  window. Per-request durations go to diagnostics
  (`createTableMaxMs`, `createTableMinMs`). **ASSUMPTION**:
  `maxMs: 60_000` wide guardrail (≈6s per create); tighten after CI history.
  `timeoutMs: 600_000`.
- **Open Assumptions**:
  - 10 tables x 20 fields. If per-create latency turns out tiny (<100ms),
    note in the summary that the count should be raised before thresholds are
    tightened — do not change the count after registration.
  - `records: []` acceptance (fallback documented above).
  - Group/runner name `table-create` (object-verb, matching `field-create` /
    `record-create`).

## Case 3: `table-delete/10k-20f`

- **Goal**: Catch regressions in archiving (deleting to trash) a 10k-record,
  20-field mixed table.
- **Runner**: **new** `table-delete` runner sharing a
  `table-lifecycle.shared.ts` module with `table-restore` (precedent:
  `record-undo-redo.shared.ts` shared by delete/undo/redo runners).
- **Seed Phase**: mixed 10k x 20f table in the shared seed base, cached and
  full-scan validated (reuse the extracted duplicate-table seed builder).
- **Execute Phase**:
  1. Ensure seed table ready.
  2. Measured: `DELETE /api/base/{baseId}/table/{tableId}` (archive route, NOT
     `/permanent`). Capture routing headers.
  3. Verify: table list for the base no longer contains the table (or
     `getTable` returns 404), AND `GET /api/trash/items?resourceType=base&
resourceId={baseId}` contains an item with `resourceId === tableId`.
  4. Cleanup (non-isolated, class C — reversible mutation): restore the table
     through `POST /api/trash/restore/{trashId}` (cleanup-only step id, e.g.
     `cleanupRestoreTable`), then verify a paged row-count scan returns
     10,000 so the seed stays cacheable. If restore fails, permanently delete
     the table so later runs reseed instead of reusing a corrupted fixture.
- **Primary Metric**: `deleteTableRequestMs`. **ASSUMPTION**: `maxMs: 30_000`
  (v1 is a metadata soft-delete transaction; wide guardrail for v2 and CI
  noise). `timeoutMs: 600_000`.
- **Open Assumptions**: archive route, not permanent delete (permanent-delete
  on big data is a candidate follow-up case); seed has no link fields, so the
  `detachLink` pre-step is cheap — a linked-table variant is a follow-up.

## Case 4: `table-restore/10k-20f`

- **Goal**: Catch regressions in restoring a 10k-record, 20-field mixed table
  from the base trash.
- **Runner**: **new** `table-restore` runner sharing
  `table-lifecycle.shared.ts` with `table-delete`.
- **Seed Phase**: same mixed 10k x 20f cached table (its own cache entry —
  seed hash includes runner kind).
- **Execute Phase**:
  1. Ensure seed table ready.
  2. Setup (NOT measured, step id `deleteSetup`): archive the table via
     `DELETE .../table/{tableId}`, confirm it landed in trash, and resolve
     `trashId` from `GET /api/trash/items?resourceType=base&resourceId={baseId}`
     (match `resourceId === tableId`). Record the setup duration as a
     diagnostic metric (`deleteSetupMs`).
  3. Measured: `POST /api/trash/restore/{trashId}`. Capture
     `x-teable-v2` / `x-teable-v2-feature: restoreTable` / `x-teable-v2-reason`
     response headers.
  4. Verify: sample rows `[0, 4999, 9999]` have the expected seed values, then
     a paged full scan confirms 10,000 rows (restore promises rows AND
     values survive).
  5. Cleanup: a successful run already leaves the seed table restored and
     seed-ready (class C) — verify and keep the cache. If the measured restore
     failed, attempt the restore again in cleanup; if that also fails,
     permanently delete the table and treat the fixture as invalid.
- **Primary Metric**: `restoreTableRequestMs`. **ASSUMPTION**: `maxMs: 60_000`
  (v2 restore validates permissions and rebuilds node cache; guardrail).
  `timeoutMs: 600_000`.
- **Open Assumptions**: delete-as-setup inside execute (matching how
  `record-undo` treats delete as setup); restore is verified through the
  normal record read path, not trash state alone.

---

## Implementation requirements (binding)

1. Follow `.agents/new-runner-contract.md` exactly for all three new runner
   kinds (`duplicate-base`, `table-create`, `table-delete`, `table-restore` —
   four kinds, three runner files plus one shared module is acceptable):
   types in `framework/types.ts`, runner files in `framework/runners/`,
   dispatch branches in `framework/run-perf-case.ts` (and seed support in
   `framework/run-perf-seed.ts` where the runner has a reusable seed),
   registration in `registry.ts`.
2. Each case: `cases/<group>/<name>.case.ts` + same-name `.md` with
   frontmatter (`owner: perf-lab`, `tags`, `enabled: true`) and the sections
   `Goal`, `Seed Phase`, `Execute Phase`, `Primary Metric`, `Notes`. Copy the
   shape of `cases/duplicate-table/10k-20f.md`.
3. Case ids equal their paths. Add literal registry aliases:
   `duplicate-base`, `table-create`, `table-delete`, `table-restore` (each
   pointing at its single case), plus the full ids.
4. Wrap every important phase in `withPerfTraceStep()` with step ids matching
   metric/phase names; primary step id = `config.threshold.metric`.
5. Throw `PerfRunDiagnosticError` with partial results on setup/execute
   failure so artifacts still land.
6. Every cleanup `finally` starts with the `isExecuteDbIsolated()`
   short-circuit.
7. Deterministic data only: values computable from row number + config.
8. Run `pnpm sync:readme` after registering; `pnpm check` must pass.

## Acceptance (do not skip)

Per `.agents/skills/localrun/SKILL.md`: refresh the sandbox, inject perf-lab,
run each case locally with `PERF_LAB_ENGINE_LIST=v1,v2`, and verify the
artifact JSON for **both engines** of **all four cases**:

- `result: "pass"`;
- routing evidence: `x-teable-v2` matches the requested engine and
  `x-teable-v2-feature` is the expected feature name;
- verification evidence complete (duplicate-base: 10,000 + 1,000 + 100 row
  scans, link remap proof, workflow count; table-create: 10 tables x 20
  fields x expected record count; table-delete: trash evidence + cleanup
  restore back to 10,000; table-restore: 10,000-row scan with sample
  values);
- primary metric present and well under `maxMs`.

Final summary must include: per-case x per-engine pass/fail + primary metric
table, every assumption above that you kept or changed (especially `maxMs`
values, the table-create empty-records fallback, and whether workflows made
it into the duplicate-base seed), files added, and the GitHub Actions trigger
command from `docs/operations/teable-ee-e2e.md`.
