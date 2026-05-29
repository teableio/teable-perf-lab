# Table Operation Perf Cases - 2026-05-29

## Scope

This pass adds five API-level table operation cases based on the current
`teable-ee` record and selection APIs:

- `POST /api/table/{tableId}/record`
- `PATCH /api/table/{tableId}/record`
- `PATCH /api/table/{tableId}/selection/clear-stream`
- `DELETE /api/table/{tableId}/selection/delete`
- `GET /api/table/{tableId}/selection/duplicate-stream`

The cases stay inside `teable-perf-lab`. `teable-ee` was used read-only to
confirm endpoint shape, range semantics, stream behavior, and practical scale.

## Implemented Cases

| Case                                                  | Real Scenario                                                                | Runner                | Primary Metric  | Verification                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------- | --------------- | -------------------------------------------------------------------- |
| `record-create/flat-10k-4fields-batch-create`         | Import or tool creates many rows through the record API.                     | `record-create`       | `create10kMs`   | Full scan verifies 10k deterministic records.                        |
| `record-update/flat-10k-4fields-batch-update`         | Bulk edit or tool updates many existing rows.                                | `record-update`       | `update10kMs`   | Full scan verifies all updated values.                               |
| `selection-clear/flat-10k-20fields-cell-clear-stream` | User clears a large 20-field visible cell selection through the stream path. | `selection-clear`     | `clear10kMs`    | Full scan verifies 10k rows remain and selected cells are empty.     |
| `record-delete/flat-10k-row-delete`                   | User selects many rows and deletes them from the grid.                       | `record-delete`       | `delete10kMs`   | Delete response includes 10k ids and the table reads back empty.     |
| `selection-duplicate/flat-1k-row-duplicate-stream`    | User duplicates selected rows through the streamed selection path.           | `selection-duplicate` | `duplicate1kMs` | Full scan verifies each deterministic `Index` appears exactly twice. |

## Runner Design

The new shared runner is `framework/runners/record-table-operation.runner.ts`.
It creates the temporary table, seeds deterministic records when needed, runs
the measured operation, verifies through the normal read path, and permanently
deletes the table.

Seed/setup is reported as `prepareMs` and is not part of the primary metric.
The primary metric starts only after the fixture is ready:

- create: empty table is ready, then batched create starts
- update: seeded table and record-id list are ready, then batched update starts
- clear/delete/duplicate: seeded table and view id are ready, then selection
  operation starts. The 10k clear case uses the product large-selection
  `clear-stream` path because product UI switches clear to stream above 200
  affected rows.

This branch intentionally contains only the five table-operation cases listed
above. Request-replay and history-operation cases should land separately after
their request design is reviewed.

## Scale Choices

Create, update, clear, and delete use 10,000 rows. Create/update are batched by
the runner, delete uses a compact row-range request, and clear uses the product
large-selection clear stream. Duplicate starts at 1,000 rows because the legacy
stream fallback duplicates records sequentially. That gives an executable first
baseline while still covering the real streamed selection endpoints.

## Review Commands

Registry validation only:

```bash
pnpm check:cases
```

Full control-plane validation:

```bash
pnpm check
```

One real CI run example:

```bash
gh workflow run "Teable EE e2e perf" \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=<teable-ee-branch-or-sha> \
  -f case_filter=record-create/flat-10k-4fields-batch-create \
  -f engine_filter=v1,v2
```

## Follow-Up Directions

- Add request-replay and history-operation cases after their separate design
  work lands.
- Add a 10k duplicate-stream case after the 1k baseline shows acceptable
  runtime in both engines.
- Add record-order and view-sort/filter mutation cases once the first five table
  operation baselines are stable.
