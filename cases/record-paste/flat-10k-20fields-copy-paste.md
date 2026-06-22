---
owner: backend-v2
tags:
  - record-paste
  - selection
  - paste
  - 10k
  - 20fields
  - wide-table
  - v1-v2
  - large-data
enabled: true
---

# record-paste/flat-10k-20fields-copy-paste

## Goal

Measure the grid paste API path for inserting 10,000 flat records into an empty
20-field table through `PATCH /api/table/{tableId}/selection/paste`.

## Seed Phase

- Creates one temporary empty table in the e2e seed base.
- The table has 20 single line text fields named `Field 01` through `Field 20`.
- Builds deterministic clipboard-style TSV content with 10,000 rows and 20
  columns, for 200,000 pasted cells total.
- Declares `maxPasteCells: 200_000` so the e2e app starts with a paste-cell
  limit that permits this wide payload.

This case intentionally keeps the table empty before measurement because the
measured operation is the paste import itself. The generated TSV is deterministic
but not currently persisted as a reusable seed artifact.

## Execute Phase

1. Run the seed phase before measurement:
   - create the empty temporary table
   - resolve the table fields and first grid view
   - build the 10k x 20-field TSV clipboard content in memory
2. Start the primary timer only after `prepare` is ready.
3. Call `PATCH /selection/paste` with:
   - `ranges: [[0, 0], [0, 0]]`
   - `projection`: the 20 visible field IDs in grid order
   - `content`: the generated TSV clipboard content
4. Assert the paste response routing matches the requested V1/V2 engine.
5. Stop the primary timer after the paste response returns.
6. Verify the paste response range is `[[0, 0], [19, 9999]]`.
7. Full scan all 10k records and verify deterministic row values, including
   first, middle, and last sample rows.
8. Permanently delete the temporary table.

## Primary Metric

- `paste10kMs`: elapsed time for the single `PATCH /selection/paste` request.

The timer starts after the empty 20-field table, projection, and deterministic
10k-row clipboard content are prepared. It includes the paste request, response
status check, and response range assertion. It does not include table creation,
TSV content generation, full-scan value verification, or table cleanup; those
steps are setup/verification diagnostics outside the threshold metric.

## Notes

This case isolates table width. It keeps the row count equal to the 4-field case
but increases pasted cell count from 40,000 to 200,000.

Each engine pastes through the endpoint its own grid uses, so the metric compares
the user behavior rather than one endpoint: V1 routes to the range-based
`PATCH /selection/paste` (`x-teable-v2: false`), V2 routes to the by-id
`PATCH /selection/paste-by-id` (`x-teable-v2: true`, `selection.recordIds: []` so
every content row is created). Both legs share the content and verification.
