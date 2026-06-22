---
owner: backend-v2
tags:
  - record-paste
  - selection
  - paste
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# record-paste/flat-10k-4fields-copy-paste

## Goal

Measure the grid paste API path for inserting 10,000 flat records into an empty
table through `PATCH /api/table/{tableId}/selection/paste`.

## Seed Phase

- Creates one temporary empty table in the e2e seed base.
- The table has four fields:
  - `Name`: single line text
  - `Index`: number
  - `Group`: single select with choices `A`, `B`, `C`, `D`, and `E`
  - `Payload`: long text
- Builds deterministic clipboard-style TSV content with 10,000 rows:
  - `Name`: `Row 00001` through `Row 10000`
  - `Index`: `1` through `10000`
  - `Group`: cycles through `A`, `B`, `C`, `D`, and `E`
  - `Payload`: `payload-<row>-<group>`
- Seed hash inputs should include the case id, `record-paste` runner kind, empty
  table field layout, paste row count, TSV generator config, fixture version,
  and seed implementation code.

The seed artifact for this case should contain the empty table and generated
clipboard payload metadata, but not the pasted records. The current runner
cold-builds the seed table and deletes it after the run.

## Execute Phase

1. Restore or build the empty seed table.
2. Resolve the table fields and first grid view.
3. Build or restore the deterministic 10k-row TSV clipboard content.
4. Start the primary timer only after the fixture is ready.
5. Call `PATCH /selection/paste` with:
   - `ranges: [[0, 0], [0, 0]]`
   - `projection`: the four visible field IDs in grid order
   - `content`: the generated TSV clipboard content
6. Assert the paste response routing matches the requested V1/V2 engine.
7. Stop the primary timer after the paste response returns.
8. Verify the paste response range is `[[0, 0], [3, 9999]]`.
9. Full scan all 10k records and verify deterministic row values, including
   first, middle, and last sample rows.
10. Clean up the pasted records or execute table state. The current runner
    deletes the temporary table as part of cleanup.

## Primary Metric

- `paste10kMs`: elapsed time for the single `PATCH /selection/paste` request.

The timer starts after the empty 4-field table, projection, and deterministic
10k-row clipboard content are prepared. It includes the paste request, response
status check, and response range assertion. It does not include table creation,
TSV content generation, full-scan value verification, or table cleanup; those
steps are setup/verification diagnostics outside the threshold metric.

## Notes

This case intentionally starts from an empty table. Manual validation confirmed
that pasting to `ranges: [[0, 0], [0, 0]]` on an empty table creates all 10,000
records and returns the expected expanded range.

Each engine pastes through the endpoint its own grid uses, so the metric compares
the user behavior rather than one endpoint: V1 routes to the range-based
`PATCH /selection/paste` (`x-teable-v2: false`), V2 routes to the by-id
`PATCH /selection/paste-by-id` (`x-teable-v2: true`, `selection.recordIds: []` on
the empty table so every content row is created). Both legs share the content and
the post-paste full-scan verification.

The CI artifact records the `prepare` phase separately so the measured
`paste10kMs` can be interpreted as the paste operation only.
