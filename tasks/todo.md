# teable-perf-lab Todo

Progress tracker. Open design decisions live in `docs/plan.md` §15; do not
duplicate them here.

- [x] Repo, architecture plan, first e2e smoke workflow and smoke case
- [x] Typed perf case framework with a single e2e entrypoint
- [x] Case suite: formula, lookup, paste, selection-clear, delete, undo, redo
- [ ] Convert plan milestones (`docs/plan.md` §13) into issues
- [ ] Durable run history (storage backend per §15)
- [ ] Observe `duplicate-base/10k-3tables-link-2workflow` vs
      `duplicate-base/10k-3tables-link-2workflow-stream` after enough runs. If
      their performance trend is effectively the same, consider removing one to
      avoid duplicate coverage.

## V1/V2 Candidate Cases

Source scan: 2026-06-15, read-only against
`/Users/leo/tea/tea-project/teable-ee`.

Current baseline:

- Runnable perf-lab cases: 41 (`cases/**/*.case.ts` and `registry.ts` match).
- V2 feature source of truth:
  `../teable-ee/community/packages/openapi/src/admin/setting/update.ts`
  (`v2FeatureSchema`).
- Controller markers checked:
  `@UseV2Feature(...)` in `community/apps/nestjs-backend/src/features/**` and
  `enterprise/backend-ee/src/features/override/controller/**`.

### Confirmed To Build

- [x] `duplicate-base/10k-3tables-link-2workflow-stream`
- [x] `import-base/v2-only-simple-1x1k-table-stream`
- [x] `import-base/v2-only-complex-3x10k-3tables-2workflow-stream`
- [x] `export-base/10k-3tables-link-2workflow-stream`
- [x] `record-read/10k-50fields-filter-sort-groupby-overhead`
- [ ] `record-update/attachment-insert-100`
- [ ] `record-update/1k-link-cells-bulk-update`
- [x] `record-delete/link-trash-1k`
- [x] `selection-paste/10k-expand-rows-and-fields-stream`
- [ ] `field-convert/10k-link-to-text`
- [ ] `field-convert/10k-text-to-link`

### Suggested Ownership Split

Claude Code batch:

- [ ] `record-update/attachment-insert-100`
- [ ] `record-update/1k-link-cells-bulk-update`
- [ ] `field-convert/10k-link-to-text`
- [ ] `field-convert/10k-text-to-link`

Current Codex thread batch:

- [x] `duplicate-base/10k-3tables-link-2workflow-stream`
- [x] `import-base/v2-only-simple-1x1k-table-stream`
- [x] `import-base/v2-only-complex-3x10k-3tables-2workflow-stream`
- [x] `export-base/10k-3tables-link-2workflow-stream`
- [x] `record-read/10k-50fields-filter-sort-groupby-overhead`
- [x] `record-delete/link-trash-1k`
- [x] `selection-paste/10k-expand-rows-and-fields-stream`

Parallel-work guardrails:

- Keep all implementation changes inside this repo; read `README.md` and
  `.agents/README.md` before writing case code.
- Do not edit `../teable-ee`; use it only as read-only product-code reference.
- After adding runnable cases, add same-name markdown, register them in
  `registry.ts`, run `pnpm sync:readme`, then run `pnpm check`.
- Coordinate before local runtime runs because the shared `teable-ee` sandbox is
  serial and should not be refreshed/injected by multiple agents at once.

### P0

- [x] `duplicate-base/10k-3tables-link-2workflow-stream`
  - V2 feature: `duplicateBase`.
  - Product path: `POST /api/base/duplicate-stream`.
  - Why: existing `duplicate-base/10k-3tables-link-2workflow` measures the JSON
    response endpoint. The product also has an SSE stream endpoint with V2
    progress events; progress/event generation can regress independently of the
    non-stream request.
  - Proposed seed: reuse the existing duplicate-base fixture shape.
  - Proposed execute: call the stream endpoint, read to `done`, assert duplicated
    base/table/record/workflow verification matches the existing runner.
  - Runner: extend `duplicate-base` with a `mode: "request" | "stream"` option,
    or add `duplicate-base-stream` if the result/event shape would make the
    existing runner hard to keep clean.
  - Primary metric: `duplicateBaseStreamMs`.
  - Teable EE files:
    `community/apps/nestjs-backend/src/features/base/base.controller.ts`,
    `enterprise/backend-ee/src/features/override/controller/base.controller.ts`,
    `community/apps/nestjs-backend/src/features/base/base.service.ts`.

- [x] `import-base/v2-only-simple-1x1k-table-stream`
- [x] `import-base/v2-only-complex-3x10k-3tables-2workflow-stream`
  - V2 feature: `importBase`.
  - Product path: `POST /api/base/import-stream`.
  - Why: `importBase` is canary-controlled and has no perf-lab coverage. It is a
    heavy base-level operation, especially with records, links, views, and
    workflows.
  - Built as two V2-only cases: simple imports one 1k-record table; complex
    imports three independent 10k-record tables plus workflow metadata. The V1
    import path is no longer maintained and is skipped by the runner.
  - Execute: export deterministic source base as setup, upload the `.tea`
    artifact, import via stream, read to `done`, then verify imported table
    count, field count, row counts, and workflow count when available.
  - Runner: dedicated `import-base` stream runner.
  - Primary metric: `importBaseStreamMs`.
  - Teable EE files:
    `community/packages/openapi/src/base/import.ts`,
    `community/apps/nestjs-backend/src/features/base/base-import.service.ts`,
    `enterprise/backend-ee/src/features/community/base/base-import.service.ts`.

- [x] `export-base/10k-3tables-link-2workflow-stream`
  - V2 surface: `exportBase` is listed in `v2FeatureSchema`, but current
    controllers do not use `@UseV2Feature('exportBase')`; they choose V2 export
    when `base.v2Status?.reason === "new_base"`.
  - Product path: `GET /api/base/{baseId}/export-stream?includeData=true`.
  - Why: base export is heavy and chunked. Even though it is not currently
    canary-routed like other features, it is still a V1/V2 implementation split
    and should be tracked if we care about base import/export regressions.
  - Proposed seed: same 10k 3-table base shape as duplicate-base.
  - Proposed execute: stream export to `done`, verify an output token/path is
    produced and progress reports expected table/row totals.
  - Runner: new `export-base` stream runner, or shared base stream runner with
    duplicate/import/export modes.
  - Primary metric: `exportBaseStreamMs`.
  - Open decision: confirm whether perf-lab can force one run against legacy
    export and one against V2 export deterministically, since this path is
    currently selected by base status rather than `V2FeatureGuard`.

### P1

- [x] `record-read/10k-50fields-filter-sort-groupby-overhead`
  - V2 feature: `getRecords`.
  - Product path: `GET /api/table/{tableId}/record`.
  - Why: existing `record-read/10k-50fields-10x1k-pages` already covers the
    heavy projection shape: 10k rows, 50 projected fields, 20 lookup fields, and
    5 formula fields. This case should reuse that exact seed table and isolate
    the incremental cost of adding query semantics: explicit `filter`, `orderBy`,
    and `groupBy`.
  - Proposed seed: reuse or share the same source/host fixture shape as
    `record-read/10k-50fields-10x1k-pages`; do not create a different table
    shape unless the existing runner cannot express the query variant.
  - Proposed execute: measure two windows against the same warmed fixture:
    1. baseline: ten 1k-page reads with the same 50-field projection and no
       explicit filter/sort/groupBy;
    2. query variant: ten reads with deterministic `filter`, `orderBy`, and
       `groupBy` over existing fields.
       Report both timings and the delta/ratio so the result answers how much
       filter/sort/groupBy adds over the current no-query read case.
  - Runner: extend `record-read`.
  - Primary metric: `getRecordsFilterSortGroupByOverheadMs` or ratio metric
    after deciding whether the gate should be absolute delta or relative
    overhead.

- [ ] `record-update/1k-link-cells-bulk-update`
  - V2 feature: `updateRecords`.
  - Product path: `PATCH /api/table/{tableId}/record`.
  - Why: current record-update case updates mixed scalar fields. Updating 1k
    link cells stresses validation, relationship resolution, and V2 projection
    side effects differently.
  - Proposed seed: 1k or 10k main records, 1k foreign records, one link field.
  - Proposed execute: bulk update 1k records to a deterministic permuted link
    target; verify full link samples and final row count.
  - Runner: extend `record-update` or add `record-update-link`.
  - Primary metric: `bulkUpdate1kLinkCellsMs`.

- [ ] `record-update/attachment-insert-100`
  - V2 feature: `updateRecords`.
  - Product path: `PATCH /api/table/{tableId}/record`.
  - Why: current record-update case updates mixed scalar fields. Attachment
    insertion stresses attachment payload validation, cell serialization, and
    record update behavior for file-like values.
  - Proposed seed: 100 host records with one empty attachment field and a stable
    deterministic attachment fixture/reference that the runtime can accept.
  - Proposed execute: bulk update 100 records to insert deterministic attachment
    references, then verify all attachment cells expose the expected metadata.
  - Runner: extend `record-update` with attachment-aware seed/verification.
  - Primary metric: `bulkUpdate100AttachmentCellsMs`.

- [x] `record-delete/link-trash-1k`
  - V2 feature: `deleteRecord`.
  - Product path: `DELETE /api/table/{tableId}/record?recordIds=...` or
    `GET /api/table/{tableId}/selection/delete-stream`.
  - Why: current `record-delete/delete-1k` covers deleting mixed records, but
    not record trash behavior when rows are referenced by link fields. V2 has
    table/record trash projections that can regress separately.
  - Proposed seed: 1k referenced main records plus a host table with populated
    link cells.
  - Proposed execute: delete referenced records, verify trash/count behavior and
    surviving link-cell display semantics.
  - Runner: extend `record-delete` or add a link-aware delete runner.
  - Primary metric: `deleteLinked1kMs`.

- [x] `selection-paste/10k-expand-rows-and-fields-stream`
  - V2 feature: `paste`.
  - Product path: `PATCH /api/table/{tableId}/selection/paste-stream`.
  - Why: current paste cases cover inserting 10k rows into an empty table. EE V2
    paste has explicit row/field expansion controls; pasting beyond current
    table shape can regress separately from plain insertion.
  - Proposed seed: small table with fewer rows/fields than pasted content.
  - Proposed execute: paste content that forces both row expansion and field
    expansion; stream to `done`, verify created records and new fields.
  - Runner: extend `record-paste` to stream mode and expansion assertions.
  - Primary metric: `pasteExpand10kMs`.
  - Teable EE files:
    `enterprise/backend-ee/src/features/override/controller/selection.controller.ts`,
    `community/apps/nestjs-backend/src/features/selection/selection.controller.ts`.

- [ ] `field-convert/10k-link-to-text`
  - V2 feature: `convertField`.
  - Product path:
    `PUT /api/table/{tableId}/field/{fieldId}/convert`.
  - Why: current convert cases cover multi-select to text and text to formula.
    Link-to-text is the conversion family that also appears as a side effect in
    legacy `deleteTable` detach behavior, so direct coverage would isolate that
    rewrite path.
  - Proposed seed: 10k host rows with populated link field pointing at 1k
    foreign rows.
  - Proposed execute: convert the populated link field to single-line text,
    wait until all values are readable, verify samples/full scan.
  - Runner: extend `field-convert`.
  - Primary metric: `convertLinkToTextReadyMs`.

- [ ] `field-convert/10k-text-to-link`
  - V2 feature: `convertField`.
  - Product path:
    `PUT /api/table/{tableId}/field/{fieldId}/convert`.
  - Why: this is the reverse user-facing conversion of
    `field-convert/10k-link-to-text`: take a populated text column whose values
    name records in another table, convert it into a link field, and preserve
    those references as real linked records. It stresses text-title matching,
    link relationship creation, and relationship value rewrite.
  - Proposed seed: 10k host rows with a text field whose values cycle through
    the primary-field titles of 1k deterministic foreign records.
  - Proposed execute: convert the populated text field to a many-one link field
    pointing at the foreign table, wait until all values are readable, and verify
    samples/full scan resolve to the expected foreign record ids and titles.
  - Runner: extend `field-convert` with link-aware seed/verification helpers.
  - Primary metric: `convertTextToLinkReadyMs`.

### Hold / Needs Product Decision

- [ ] `schema-integrity/*-repair-stream`
  - Reason to hold: repair cases need deliberately inconsistent physical/meta
    state. That likely requires controlled SQL mutation in the seed phase, which
    is riskier than normal product-API-only perf fixtures. Add after the clean
    check-stream runner exists.
