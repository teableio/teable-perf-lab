# Standard Case Examples

Do not treat one case as the universal template. Pick the closest standard case
for the behavior you are changing, then read both its `.case.ts` and `.md`.

This file is a curated set of pointers, not an inventory and not a spec. The
full runnable list lives in `registry.ts` (the root README "Available Cases"
section is its generated view). When prose here disagrees with the referenced
`.case.ts`, `.md`, or runner code, the code wins — read the referenced files
before copying a pattern.

## Naming Pattern

Case ids should read like:

```text
<area>/<workload-shape>-<scale>-<schema-or-field-count>-<operation>
```

Omit parts that do not add meaning. Keep names literal: if the executable case
is 1k, name it `1k`; do not keep a `10k` alias or title for compatibility.

Common examples:

- `formula/10k-calc`: area + scale + operation.
- `lookup/conditional-10k`: area + operation + scale.
- `selection-clear/flat-1k-20fields-cell-clear-stream`: data shape + scale +
  field count + operation/path.
- `record-delete/delete-1k`: operation + scale.
- `record-undo/delete-1k`: measured replay action + setup operation + scale.
- `record-redo/delete-1k`: measured replay action + setup operation + scale.
- `record-paste/mixed-10k-20fields-complex-copy-paste`: data shape + scale +
  field count + operation.
- `csv-import/mixed-10k-20fields-inplace-import`: data shape + scale + field
  count + import mode.

The file names must match the case id:

```text
cases/<area>/<case-name>.case.ts
cases/<area>/<case-name>.md
```

For example, `record-undo/delete-1k` lives at:

```text
cases/record-undo/delete-1k.case.ts
cases/record-undo/delete-1k.md
```

## Computed Fields

Use these when the measured operation creates computed fields and waits for
values to become ready:

- Single formula field:
  - `cases/formula/10k-calc.case.ts`
  - `cases/formula/10k-calc.md`
- Multiple formula fields on the same seed table:
  - `cases/formula/10k-5-concurrent.case.ts`
  - `cases/formula/10k-5-concurrent.md`
- Conditional lookup across two seeded tables:
  - `cases/lookup/conditional-10k.case.ts`
  - `cases/lookup/conditional-10k.md`
- Conditional rollup across the same deterministic source/host shape:
  - `cases/rollup/conditional-10k.case.ts`
  - `cases/rollup/conditional-10k.md`

Notice how these cases keep deterministic source rows in seed, create the
computed field in execute, and verify readiness by scanning records. The paired
conditional lookup/rollup cases share a seed identity so selecting both does not
rebuild the same two 10k-row tables.

## Field Lifecycle

Use these when the measured operation creates, converts, deletes, or
duplicates fields on a seeded table:

- Sequential external create-field requests (simple, formula, or mixed):
  - `cases/field-create/10k-create-5-simple-fields.case.ts`
  - `cases/field-create/10k-create-5-formula-fields.case.ts`
  - `cases/field-create/mixed-10k-create-19-fields.case.ts`
- One field with a very large option set:
  - `cases/field-create/single-select-1k-options.case.ts`
- Field type conversion that rewrites or recomputes every cell:
  - `cases/field-convert/10k-multi-select-to-text.case.ts`
  - `cases/field-convert/10k-text-to-formula.case.ts`
- Bulk field delete in one request:
  - `cases/field-delete/mixed-10k-delete-19-fields.case.ts`
- Duplicate a computed field on an existing fixture:
  - `cases/field-duplicate/conditional-lookup-10k.case.ts`

Notice that create cases model real external behavior: the public OpenAPI only
exposes single-field `POST /api/table/{tableId}/field`, so multi-field cases
send sequential requests inside one measurement window instead of inventing a
bulk API. Convert cases go through
`PUT /table/{tableId}/field/{fieldId}/convert` (canary feature
`convertField`) and verify every converted cell value.

## Selection Mutations

Use these when the measured operation is a grid selection action:

- Clear cells through the clear stream:
  - `cases/selection-clear/flat-1k-20fields-cell-clear-stream.case.ts`
  - `cases/selection-clear/flat-1k-20fields-cell-clear-stream.md`
- Delete selected rows through the synchronous grid delete API:
  - `cases/record-delete/delete-1k.case.ts`
  - `cases/record-delete/delete-1k.md`
- Undo a selection delete:
  - `cases/record-undo/delete-1k.case.ts`
  - `cases/record-undo/delete-1k.md`
- Redo a selection delete:
  - `cases/record-redo/delete-1k.case.ts`
  - `cases/record-redo/delete-1k.md`

Notice that delete, undo, and redo use the same synchronous setup delete path:
`DELETE /api/table/{tableId}/selection/delete`, the same UI-shaped range, and
the same `X-Window-Id` across the operation chain. Undo and redo stream only the
replay step.

## Paste

Use these when the measured operation imports records through paste:

- Flat 4-field paste:
  - `cases/record-paste/flat-10k-4fields-copy-paste.case.ts`
  - `cases/record-paste/flat-10k-4fields-copy-paste.md`
- Flat 20-field paste:
  - `cases/record-paste/flat-10k-20fields-copy-paste.case.ts`
  - `cases/record-paste/flat-10k-20fields-copy-paste.md`
- Mixed 20-field paste:
  - `cases/record-paste/mixed-10k-20fields-complex-copy-paste.case.ts`
  - `cases/record-paste/mixed-10k-20fields-complex-copy-paste.md`

Notice that paste keeps inserted rows in execute because insertion is the
measured workload. Do not cache already-pasted records unless the case is
explicitly changed into a read/verify benchmark.

## CSV Import

Use this when the measured operation imports CSV rows into an existing table:

- Mixed 20-field CSV import:
  - `cases/csv-import/mixed-10k-20fields-inplace-import.case.ts`
  - `cases/csv-import/mixed-10k-20fields-inplace-import.md`

Notice that CSV upload and analyze are setup diagnostics, while the primary
metric starts at the import request and ends after records read verification.

## Bulk Record Mutations (OpenAPI)

Use these when the measured operation hits the record OpenAPI directly instead
of grid selection, paste, or import:

- Bulk create typed records in one request:
  - `cases/record-create/mixed-1k-20fields-bulk-create.case.ts`
- Bulk update existing records in one request:
  - `cases/record-update/mixed-1k-20fields-bulk-update.case.ts`
- Reorder a visible block of records in one operation:
  - `cases/record-reorder/10k-move-last-1k-to-front.case.ts`

Notice that these cases deliberately avoid grid paste, selection streams,
computed fields, and undo/redo so V1 and V2 compare the same direct endpoint
path.

## Read Paths

Use these when the measured operation reads data without mutating the seed:

- Paged full-table record read with wide projection:
  - `cases/record-read/10k-50fields-10x1k-pages.case.ts`
- Global search with the table search index off vs on:
  - `cases/search/search-index-off-10k-20search-fields.case.ts`
  - `cases/search/search-index-on-10k-20search-fields.case.ts`

Notice that the search OFF/ON cases share one deterministic seed fixture
(source plus both host tables) so the pair reuses the same DB seed cache, and
each case measures only its own mode.

## Smoke

Use this when the case needs no fixture and only times an HTTP endpoint:

- Authenticated profile endpoint:
  - `cases/smoke/auth-user.case.ts`

Notice that it relies on the standard e2e seed user only — no tables, no
seed cache participation.
