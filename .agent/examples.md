# Standard Case Examples

Do not treat one case as the universal template. Pick the closest standard case
for the behavior you are changing, then read both its `.case.ts` and `.md`.

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

Notice how these cases keep deterministic source rows in seed, create the
computed field in execute, and verify readiness by scanning records.

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
