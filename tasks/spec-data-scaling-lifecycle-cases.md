# Spec: data-scaling variants for table lifecycle + createTable

## Implementation status (2026-06-12) — READ THIS FIRST

Branch: `feat/data-scaling-lifecycle-cases`. The implementation is **done**
and `pnpm check` passes. What remains is local runtime verify on v1+v2 and
any runtime fixes. If you are the verifying agent, your job is:

1. Follow `.agents/skills/localrun/SKILL.md`: refresh the sandbox, inject
   perf-lab, then run each case with `PERF_LAB_ENGINE_LIST=v1,v2`:
   `table-restore/10k-20f-link-1k`, `table-delete/10k-20f-link-detach`,
   `table-create/1x-20f-1k-records`.
2. Check artifact JSON per engine per the Acceptance section below.
3. Fix runner/case code on failure, re-run `pnpm check`, re-inject, repeat.
4. Calibrate thresholds from measured numbers (update the case `.case.ts`
   comment + `maxMs` and the md if reality diverges badly from expectations).
5. Do NOT modify anything under `../teable-ee`.
6. Do not push; report results back.

## Why these cases exist (record of the data-scaling analysis)

The four lifecycle features merged in PR #35 split into two classes:

- **Inherently data-scaling, already covered**: `duplicateBase` copies every
  record of the source base; `duplicate-base/10k-3tables-link-2workflow`
  (1.5–3 s for 11.1k records) is itself the scaling case. No new case.
- **Metadata-only today, record-count independent**: `createTable` with
  `records: []`, soft `deleteTable`, `restoreTable` (~22 metadata row updates,
  ~40 ms regardless of 10k rows). Each gets a data-scaling variant:

| New case                           | Scaling dimension                                                                                                                                                   | Expected today                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `table-delete/10k-20f-link-detach` | v1 soft delete runs `detachLink`: converts the surviving table's link field cell-by-cell, O(surviving rows), inside the request. v2 soft delete skips side effects. | v1: seconds; v2: tens of ms; huge engine gap is **expected and semantic** |
| `table-restore/10k-20f-link-1k`    | none yet — sentinel. Restore is a metadata flip even with 10k populated link cells; fires if restore ever gains O(records) work.                                    | both engines ~tens of ms                                                  |
| `table-create/1x-20f-1k-records`   | inline records ride the createTable request (v1 `createInitialRecords`, v2 maps records into the v2 create input).                                                  | both engines: record-insert dominated, ~1–3 s expected                    |

Source evidence (teable-ee, do not modify):

- v1 `deleteTable` / `detachLink` / `restoreTable`:
  `community/apps/nestjs-backend/src/features/table/open-api/table-open-api.service.ts:593,429,623`
  — detachLink converts every inbound link field of OTHER tables via
  `convertField(..., SingleLineText)`; the deleted table's own link fields
  stay intact for restore.
- v2 `DeleteTableHandler`:
  `community/packages/v2/core/src/commands/DeleteTableHandler.ts:78` —
  `shouldRunSideEffects = command.mode === 'permanent'`, so soft delete skips
  the cross-table reactions.
- v1 createTable inline records:
  `table-open-api.service.ts:350,367` — `createInitialRecords` runs
  `createRecords` with `fieldKeyType: Name` and **no typecast**.

## Files delivered

- `framework/types.ts` — runner kinds `table-delete-link`,
  `table-restore-link`; `TableLifecycleLinkConfig` (type alias, JsonValue
  rule), `TableDeleteLinkCaseConfig`, `TableRestoreLinkCaseConfig`;
  `TableCreateCaseConfig.inlineRecords` + metric `createTable1x1kRecordsMs`.
- `framework/runners/table-lifecycle-link.shared.ts` — NEW: link-pair fixture
  (main 10k×20f + one-way `Ref Link` -> foreign 1k `Key`/`Note`), per-sample
  seed-cache identity, cache validation that detects a v1-poisoned pair (link
  field converted to text) and rebuilds, `assertLinkCellSamples`,
  `getLinkFieldState`, `permanentDeleteLinkFixture`.
- `framework/runners/table-restore-link.runner.ts` — archive main (setup),
  measured trash restore, verify full scan + text samples + link samples.
- `framework/runners/table-delete-link.runner.ts` — measured archive of the
  FOREIGN table, verify main table integrity + record link-field state,
  cleanup restores the foreign table and keeps the pair only when intact
  (v2 path).
- `framework/runners/table-create.runner.ts` — optional inline records with a
  typecast-free value generator; record-count + sample verification.
- Existing `table-delete.runner.ts`, `table-restore.runner.ts`,
  `table-lifecycle.shared.ts`, `record-undo-redo.shared.ts` are **untouched**
  (no seed-cache invalidation for the merged cases).
- Dispatch (`run-perf-case.ts`, `run-perf-seed.ts`), `registry.ts` (37 cases,
  aliases `table-restore/link`, `table-delete/link-detach`,
  `table-create/1k-records`), 3 case files + 3 md files, scaling notes
  appended to the 4 sibling md files, README Available Cases synced.

## Runtime-risk assumptions to validate first when something fails

1. `isOneWay: true` is accepted in link field options at table creation, and
   no symmetric field appears in the foreign table (check `getFields` on the
   foreign table after seeding). If rejected: the fixture degrades to a
   symmetric link and v1 archive of the MAIN table would convert the foreign
   mirror field — restore-link cleanup/cache validation would start
   rebuilding every run.
2. Link cell payload `{ id: recordId }` with `typecast: true` at record
   creation works for a one-way many-one link (proven for normal many-one in
   duplicate-base seeding).
3. Link cell read shape `{ id, title }` with `title` = foreign primary `Key`
   value (assertLinkCellSamples relies on it).
4. v1 measured delete of the foreign table completes the 10k-cell conversion
   inside the request and under the 60 s threshold / 1800 s case timeout; the
   main-table full scan immediately after returns 10k rows.
5. v2 soft delete of the foreign table leaves the main link field `type:
"link"` and the link cells readable after the cleanup restore (fixture
   kept). After a v1 run the link field reads `singleLineText` and the cache
   validation must rebuild the pair on the next run — watch for the
   `Invalid cached link seed ... rebuilding` warning, it is expected on v1.
6. Inline createTable records validate without typecast: Date cells are full
   ISO strings, checkbox cells are `true` or omitted (never `false`),
   select cells are exact choice names. If v1 or v2 rejects a value type,
   adjust `inlineCellValue` in `table-create.runner.ts` (and the md note).
7. v2 createTable with 1k inline records returns 201 and actually inserts
   the records (the v2 path maps `records` into the v2 create input;
   verification scans for exactly 1,000).
8. Routing headers on the new flows: `x-teable-v2-feature` is `deleteTable`
   for the foreign-table archive and `restoreTable` for the trash restore;
   `routeMatched` must be true per engine.
9. `getRecords` calls in table-create verification use default
   `fieldKeyType` (name keys) — sample checks read `record.fields[fieldName]`.

## Acceptance

Per engine (v1, v2), per case, in the artifact JSON:

- `result` pass; primary threshold respected. Thresholds were calibrated from
  the 2026-06-12 local verification (`restoreTableP95Ms` <= 1000,
  `deleteTableDetachLinkP95Ms` <= 10000, `createTable1x1kRecordsMs` <= 10000;
  measured v1/v2: restore 36/23 ms, delete-link 1079/23 ms,
  create-1k 1371/918 ms, all `routeMatched: true`).
- `details.routing.routeMatched: true` (single engine header set).
- restore-link: every sample's verify includes full scan 10000 +
  link samples verified; fixtures left restored and reusable
  (`details.seed.samples[*].cache.reusable: true` on cache-enabled runs).
- delete-link: `details.cleanup.samples[*].linkStateAfterRestore.type` is
  `singleLineText` on v1 and `link` on v2 (record the values in the report);
  `fixtureIntact` true on v2, false on v1.
- create-1k: `details.verification.tables[0].recordCount: 1000`,
  `details.inlineRecordCount: 1000`.
- Record measured numbers (per engine p95/total) in the verification report
  so thresholds can be calibrated.
