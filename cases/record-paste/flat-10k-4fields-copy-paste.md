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
6. Stop the primary timer after the paste response returns.
7. Verify the paste response range is `[[0, 0], [3, 9999]]`.
8. Full scan all 10k records and verify deterministic row values, including
   first, middle, and last sample rows.
9. Clean up the pasted records or execute table state. The current runner
   deletes the temporary table as part of cleanup.

## Primary Metric

- `paste10kMs`: elapsed time for the single `PATCH /selection/paste` request.

## Notes

This case intentionally starts from an empty table. Manual validation confirmed
that pasting to `ranges: [[0, 0], [0, 0]]` on an empty table creates all 10,000
records and returns the expected expanded range.

Fixture preparation and post-paste verification are outside the primary metric.
The CI artifact records the `prepare` phase separately so the measured
`paste10kMs` can be interpreted as the paste operation only.
