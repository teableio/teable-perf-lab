---
owner: backend-v2
tags:
  - reorder
  - record
  - 10k
  - 1k-block
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# record-reorder/10k-move-last-1k-to-front

## Goal

Measure block reorder performance in a 10,000-row grid by moving the original
last 1,000 visible records to the front in one operation.

This case isolates view row ordering work: anchor lookup, order value
calculation, batched order writes, and V1/V2 routing differences. It does not
update record field values.

## Seed Phase

- Creates one 10,000-row table in the e2e seed base.
- Uses a 20-field mixed schema matching the CSV import mixed case shape:
  single line text, long text, single select, multiple select, number, date,
  checkbox, and rating fields.
- Inserts deterministic records in natural order. The primary title field runs
  from `Mixed row 00001` through `Mixed row 10000`.
- Uses the first plain grid view with no sort, filter, or group so manual view
  order is observable.
- On cache miss, reads the initial view order once and stores the reorder
  metadata in the seed table description: original record ids, anchor id, moved
  block ids, and restore anchor id.
- On cache hit, reuses the cached reorder metadata when version, row count, and
  field ids still match.

## Execute Phase

1. Start the primary timer.
2. Call `PATCH /api/table/{tableId}/record` with:
   - `records`: the original last 1,000 record ids, each with `fields: {}`
   - `order`: `{ viewId, anchorId: originalFirstRecordId, position: "before" }`
   - a stable per-run `X-Window-Id`
3. Stop the primary timer after the reorder PATCH response.
4. Assert the reorder response routing matches the requested V1/V2 engine.
5. Verify sampled view positions: rows 1, 500, and 1,000 are from the moved
   block, and row 1,001 is the original first row.
6. Verify sampled mixed-field values by reading the sampled original rows at
   their reordered view positions.
7. Cleanup restores the cached seed table to its original order for local
   single-database runs. Isolated execute databases can keep the mutated order
   because the job discards them.

## Primary Metric

- `moveLast1kToFrontMs`: elapsed time for the reorder PATCH request only.

Sample order and value verification is recorded separately as `verifyReorderMs`.

## Notes

The request intentionally sends empty field payloads so the measured operation
is row order mutation rather than data update. Routing headers and trace ids are
recorded in the run artifact for V1/V2 comparison.
