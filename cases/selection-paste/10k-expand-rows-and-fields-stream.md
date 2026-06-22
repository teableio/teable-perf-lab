---
owner: backend-v2
tags:
  - selection-paste
  - record-paste
  - paste
  - stream
  - row-expansion
  - field-expansion
  - 10k
  - v1-v2
enabled: true
---

# selection-paste/10k-expand-rows-and-fields-stream

## Goal

Measure pasting a large spreadsheet-shaped block into a smaller grid through
the product paste stream path, forcing both row expansion and field expansion.

## Seed Phase

- Creates a temporary table in the seed base.
- The table starts with only 10 rows and 2 single-line text fields.
- Builds deterministic TSV clipboard content with 10,000 rows and 20 columns.
- The paste header carries all 20 desired fields, so the runtime must create the
  missing 18 fields and add the missing rows while applying cell values.

This runner intentionally does not use the reusable seed cache. The measured
workload creates the final table shape as part of paste execution, so the
temporary table is deleted after execute in non-isolated local runs.

## Execute Phase

1. Prepare the small 10-row, 2-field table and deterministic 10k x 20 TSV
   content.
2. Measured: call
   `PATCH /api/table/{tableId}/selection/paste-stream` with the table view,
   existing projection, desired field header, and TSV content.
3. Read the SSE response until the `done` event and assert no stream error
   events occurred.
4. Assert paste routing headers match the requested V1/V2 engine.
5. Resolve final fields after paste, then full-scan all 10,000 records across
   all 20 fields and verify deterministic sample rows.
6. Permanently delete the temporary table in non-isolated local runs.

## Primary Metric

- `pasteExpand10kMs`: elapsed time from sending the paste stream request until
  the SSE `done` event is received.

Full-scan verification and cleanup are diagnostics outside the threshold.

## Notes

This differs from the existing `record-paste/*copy-paste` cases: those paste
into a table that already has the final fields. This case measures the product
behavior users see when Excel/Sheets content is larger than the current Teable
grid.

Each engine pastes through the stream endpoint its own grid uses, so the metric
compares the user behavior rather than one endpoint: V1 routes to the
range-based `PATCH /selection/paste-stream` (`x-teable-v2: false`), V2 routes to
the by-id `PATCH /selection/paste-by-id-stream` (`x-teable-v2: true`). The V2
body anchors on the real seeded record ids so content rows beyond them are
created (row expansion) and header fields beyond the projection are created
(field expansion), matching the range body's expansion. Both legs share the
seed, content, and verification.
