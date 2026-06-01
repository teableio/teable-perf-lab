---
owner: backend-v2
tags:
  - selection-clear
  - stream
  - table-operation
  - 1k
  - v1-v2
  - 20fields
  - mixed-fields
enabled: true
---

# selection-clear/flat-1k-20fields-cell-clear-stream

## Goal

Measure the grid selection-clear stream path for clearing every visible cell
across 1,000 rows and 20 mixed fields through
`PATCH /api/table/{tableId}/selection/clear-stream`.

This uses the shared stream endpoint in both V1 and V2. The workload stays at
1,000 rows so the V1 legacy fallback can resolve the selected row ids while the
request still crosses the product stream threshold.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 1,000 deterministic mixed records in one 1,000-record batch.
- Resolves the first grid view id and visible field ids.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.
- When seed cache is enabled, the hash-derived source table is reused across
  engines and workflow runs. After execute clears the cells, cleanup writes the
  deterministic values back and validates the table before preserving it.

## Execute Phase

1. Start the primary timer after the source table is ready.
2. Call `PATCH /selection/clear-stream` with the product large-selection shape:
   `ranges: [[0, 0], [19, 999]]`, `projection`, and `viewId`.
3. Stop the primary timer after the clear stream emits its final `done` event.
4. Full scan all 1,000 records and verify the selected fields are empty.
5. Cleanup restores the cached seed table when reusable, otherwise permanently
   deletes the temporary table.

## Primary Metric

- `clear1kMs`: elapsed time for the single selection-clear stream request.

## Verification

- The stream `done` event must report 1,000 processed and cleared rows.
- The table must still contain 1,000 records.
- Every projected field must be empty in a full paged scan.
- Samples from rows 1, 500, and 1,000 are saved in the result artifact.
- V1 and V2 both run the same `clear-stream` endpoint.

## Notes

The product switches clear to the stream endpoint when the affected row count is
greater than 200. This 1k case intentionally measures that stream path while
remaining comparable across engines. It measures clearing content, not deleting
records, so verification expects the row count to remain 1,000.
