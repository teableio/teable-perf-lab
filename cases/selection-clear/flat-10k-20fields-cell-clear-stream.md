---
owner: backend-v2
tags:
  - selection-clear
  - table-operation
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# selection-clear/flat-10k-20fields-cell-clear-stream

## Goal

Measure the product large-clear path for clearing every visible cell across
10,000 rows and 20 mixed fields through
`PATCH /api/table/{tableId}/selection/clear-stream`.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 10,000 deterministic mixed records in 1,000-record batches.
- Resolves the first grid view id and visible field ids.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.
- When seed cache is enabled, the hash-derived source table is reused across
  engines and workflow runs. After execute clears the cells, cleanup writes the
  deterministic values back and validates the table before preserving it.

## Execute Phase

1. Start the primary timer after the source table is ready.
2. Call `PATCH /selection/clear-stream` with the product large-selection shape:
   `ranges: [[0, 0], [19, 9999]]`, `projection`, and `viewId`.
3. Stop the primary timer after the clear stream emits its final `done` event.
4. Full scan all 10,000 records and verify the selected fields are empty.
5. Cleanup restores the cached seed table when reusable, otherwise permanently
   deletes the temporary table.

## Primary Metric

- `clear10kMs`: elapsed time for the single selection-clear stream request.

## Verification

- The stream `done` event must report 10,000 processed and cleared rows.
- The table must still contain 10,000 records.
- Every projected field must be empty in a full paged scan.
- Samples from rows 1, 5,000, and 10,000 are saved in the result artifact.
- V1 is reported as `skipped`: its legacy clear-stream path resolves the 10k
  range through a search-index API capped at 1,000 records, so running it would
  not measure the same large-clear behavior as V2.

## Notes

The product switches clear to the stream endpoint when the affected row count is
greater than 200. This 10k case intentionally measures that large-clear path. It
measures clearing content, not deleting records, so verification expects the row
count to remain 10,000.
