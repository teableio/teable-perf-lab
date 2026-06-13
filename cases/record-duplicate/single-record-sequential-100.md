---
owner: backend-v2
tags:
  - record-duplicate
  - duplicate-record
  - record-operation
  - sequential
  - p95
  - 1k
  - v1-v2
  - 20fields
  - mixed-fields
enabled: true
---

# record-duplicate/single-record-sequential-100

## Goal

Catch regressions in the single-record duplicate path by duplicating 100
distinct records one request at a time through
`POST /api/table/{tableId}/record/{recordId}/duplicate`.

This case targets the `duplicateRecord` canary feature at the single-request
latency layer. It complements the grid block duplicate stream case by measuring
p95 latency for individual record duplicate requests.

## Seed Phase

- Creates one reusable table in the e2e seed base.
- Uses the same 20 mixed-field shape as the selection-clear workload: text,
  long text, single select, multiple select, number, date, checkbox, and rating.
- Seeds 1,000 deterministic source records in one 1,000-record batch.
- Resolves the first grid view id and all projected field ids.
- When seed cache is enabled, the hash-derived source table is reused after a
  full seed-ready scan validates record count and deterministic values.

## Execute Phase

1. Read the first 100 source record ids after the source table is seed-ready.
2. Duplicate those 100 records sequentially with
   `POST /record/{recordId}/duplicate`, timing each request separately.
3. Aggregate the request durations into a p95 primary metric and record total
   and max latency as diagnostics.
4. Assert each response returns a created duplicate whose values match the
   deterministic source row.
5. Assert routing for every request and record first/last routing evidence in
   the artifact.
6. Fetch all created duplicate ids through the records API and verify their cell
   values match the deterministic source rows.
7. Full scan the table and prove the final row count is 1,100.
8. Cleanup deletes the 100 created ids in local single-database runs so the
   cached 1,000-row seed table is reusable. Isolated execute databases are
   discarded by the job.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency over the 100 single-record duplicate
  requests.

`duplicateSingleTotalMs` and `duplicateSingleMaxMs` are recorded as diagnostics.
Seed preparation, source id lookup, post-duplicate verification, row-count scan,
and local cleanup are outside the threshold metric.

## Verification

- The runner must create 100 duplicate record ids.
- The table must contain 1,100 rows after the duplicate loop.
- Fetching the duplicate ids must scan 100 created records and prove all values
  match the deterministic source rows.
- Samples from duplicated rows 1, 50, and 100 are saved in the result artifact.
- V1 and V2 both run the same endpoint, and the run fails if routing or feature
  evidence does not match.

## Notes

The initial 4,000 ms threshold is a wide per-request p95 guardrail. It should be
tightened after real CI history is available.
