---
owner: perf-lab
tags:
  - table-create
  - tables
enabled: true
---

# table-create/10x-20f-no-records

## Goal

Measure creating 10 tables, each with 20 mixed fields and no records,
sequentially inside one timed window.

## Seed Phase

None beyond the shared seed base. The created tables are the measured workload,
so there is no reusable seed cache (the same class as the paste cases).

## Execute Phase

1. Build 10 deterministic payloads locally: the shared mixed 20-field schema,
   `records: []`, and run-tagged table names.
2. Measured window: loop the 10 `POST /api/base/{baseId}/table` requests
   sequentially. Each request runs under its own trace step
   (`createTable-01` .. `createTable-10`) and captures `x-teable-v2*` routing
   headers; the runner asserts all 10 requests routed to the requested V1/V2
   engine.
3. Verify each created table: all 20 fields present with expected names, at
   least one view, and zero records.
4. Cleanup permanently deletes all created tables, including any partial set
   when the loop fails midway.

## Primary Metric

- `createTables10xTotalMs`: wall time of the 10-create window. Repetition
  rather than record volume amplifies the schema-creation signal, so the
  metric stays specific to the createTable path instead of being dominated by
  record insertion (already covered by the record-create cases).

## Verification Metrics

- `createTableMinMs` / `createTableP50Ms` / `createTableP95Ms` /
  `createTableMaxMs`: per-request distribution (diagnostic).
- `createTablesVerifyMs`: post-window schema and emptiness verification.
  Diagnostic only; it does not participate in the primary threshold.

## Notes

- The payload sends `records: []` explicitly, which creates zero records (the
  server only generates 3 default records when the key is omitted).
- If per-create latency turns out tiny in CI, raise the table count in a NEW
  case id before tightening thresholds; never change the workload of this id.
- Data-scaling companion: `table-create/1x-20f-1k-records` carries 1,000
  inline records in the create request, covering the record-dependent
  share of createTable that this case deliberately excludes.
