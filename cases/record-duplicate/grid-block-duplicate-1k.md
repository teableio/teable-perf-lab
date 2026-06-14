---
owner: backend-v2
tags:
  - record-duplicate
  - duplicate-record
  - selection-stream
  - table-operation
  - 10k
  - 1k
  - v1-v2
  - 20fields
  - mixed-fields
enabled: true
---

# record-duplicate/grid-block-duplicate-1k

## Goal

Catch regressions in the grid duplicate selected rows path by duplicating a
block of 1,000 rows in a 10,000-row mixed table through
`GET /api/table/{tableId}/selection/duplicate-stream`.

This case targets the `duplicateRecord` canary feature at the bulk grid stream
layer. It complements the single-record duplicate case by measuring the
throughput path that resolves a row range and inserts all duplicated records in
one streamed operation.

## Seed Phase

- Creates one reusable table in the e2e seed base.
- Uses the same 20 mixed-field shape as the selection-clear workload: text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Seeds 10,000 deterministic source records in 1,000-record batches.
- Resolves the first grid view id and all projected field ids.
- When seed cache is enabled, the hash-derived source table is reused after a
  full seed-ready scan validates record count and deterministic values.

## Execute Phase

1. Start the primary timer after the source table is seed-ready.
2. Call `GET /selection/duplicate-stream` with `type: "rows"`,
   `ranges: [[0, 999]]`, `viewId`, and all field ids as the projection.
3. Stop the primary timer when the stream emits its final `done` event.
4. Assert no stream `error` events occurred and the `done` event reports 1,000
   duplicated rows and 1,000 duplicated record ids.
5. Assert response routing matched the requested V1/V2 engine and the
   `duplicateRecord` feature.
6. Fetch the 1,000 duplicated ids through the records API and verify their cell
   values match the deterministic source rows.
7. Full scan the table and prove the final row count is 11,000.
8. Cleanup deletes the duplicated ids in local single-database runs so the
   cached 10,000-row seed table is reusable. Isolated execute databases are
   discarded by the job.

## Primary Metric

- `duplicateBlock1kMs`: elapsed time for the single duplicate stream request.

The timer covers only the `duplicate-stream` request and SSE parsing through the
final `done` event. It does not include seed preparation, seed-ready validation,
post-duplicate value verification, row-count scan, or local cleanup.

## Verification

- The stream `done` event must report 1,000 duplicated rows.
- The stream must return 1,000 duplicated record ids.
- Fetching those ids must scan 1,000 duplicated records and prove all values
  match the deterministic source rows.
- The table must contain 11,000 rows after duplication.
- Samples from duplicated rows 1, 500, and 1,000 are saved in the result
  artifact.
- V1 and V2 both run the same endpoint, and the run fails if routing or feature
  evidence does not match.

## Notes

The 240,000 ms threshold is a wide guardrail for a stream that reads and inserts
1,000 mixed rows. The v1 legacy per-row stream is ~100x slower than v2 (CI:
v1 ~84s vs v2 ~0.8s), so the guardrail keeps ~2.8x headroom over the observed v1
worst case to avoid CI load false-fails. It should be tightened after more real
CI history is available.
