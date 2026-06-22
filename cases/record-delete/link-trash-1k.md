---
owner: backend-v2
tags:
  - record-delete
  - delete
  - selection
  - link
  - trash
  - 1k
  - v1-v2
enabled: true
---

# record-delete/link-trash-1k

## Goal

Measure deleting 1,000 records from a table whose rows contain populated link
cells, covering the record-trash path for linked records rather than plain
scalar-row deletion.

## Seed Phase

- Creates a foreign table with 1,000 deterministic records whose primary `Key`
  values are `DELETE-LINK-00001` through `DELETE-LINK-01000`.
- Creates a main table with 1,000 mixed 20-field records.
- Adds a one-way many-one link field named `Linked Foreign` on the main table.
- Every main row points to a deterministic foreign row using multiplier `7` and
  offset `3`, so samples can prove the link cells are populated and stable.
- Verifies all main rows are readable and link sample cells resolve to the
  expected foreign record titles before execute.

## Execute Phase

1. Restore or build the linked 1k-row main table plus foreign table.
2. Start the primary timer after seed and link readiness checks pass.
3. Call `DELETE /api/table/{tableId}/selection/delete` over the full 1k-row grid
   range, using the same `x-window-id` behavior as the UI.
4. Assert the delete response routing matches the requested V1/V2 engine.
5. Stop the primary timer after the delete response returns 1,000 deleted ids.
6. Verify the main table has no visible records and the foreign table remains
   readable.

## Primary Metric

- `deleteLinked1kMs`: elapsed time for the synchronous selection-delete request
  against the linked main table.

Seed readiness, link-cell sample validation, post-delete verification, and local
undo cleanup are diagnostics outside the threshold.

## Notes

This case complements `record-delete/delete-1k`. The existing case deletes
mixed scalar rows; this case deletes rows whose link cells participate in
relationship/trash handling.

Like `record-delete/delete-1k`, each engine deletes through the endpoint its own
grid uses: V1 routes to `DELETE /selection/delete` (`x-teable-v2: false`), V2
routes to `POST /selection/delete-by-id` (`x-teable-v2: true`,
`selection.excludeRecordIds: []`). Both legs share the seed and verification.
