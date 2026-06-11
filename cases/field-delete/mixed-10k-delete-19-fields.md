---
owner: backend-v2
tags:
  - field
  - delete
  - 10k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# field-delete/mixed-10k-delete-19-fields

## Goal

Measure the bulk field delete path for removing 19 mixed-type fields from a
10,000-row table in one request.

Field delete has separate V1 and V2 implementations behind
`@UseV2Feature('deleteField')`, so this case compares the two engines on the
same workload.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table mirrors the staging Tibo test shape: 20 mixed fields covering text,
  long text, single select, multiple select, number, date, checkbox, and
  rating. `Title` is the primary field; the other 19 fields are deletable.
- Inserts 10,000 deterministic records in 1,000-record batches so every
  deletable field column holds data when it is dropped.
- Verifies the source table is ready by full-scanning 10,000 records and
  checking the expected row count; the shared fixture builder also resolves all
  20 configured fields by name, so a cached table whose fields were already
  deleted is discarded and rebuilt.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. In GitHub Actions each engine restores its own seed database
  copy, so execute may drop fields without repairing the shared seed dump.

## Execute Phase

1. Start the primary timer only after the 10k source table is ready.
2. Call `DELETE /api/table/{tableId}/field?fieldIds=...` once with all 19
   deletable field ids and a stable per-run `x-window-id`.
3. Stop the primary timer when the synchronous response returns.
4. Record routing headers such as `x-teable-v2`, `x-teable-v2-feature`, and
   `x-teable-v2-reason` in the run artifact, and fail if the response did not
   come from the requested engine.
5. Verify through the real read path that only the `Title` field remains and
   that a paged full scan still returns 10,000 records.
6. Cleanup does not try to repair the mutated fixture: isolated execute
   databases (GitHub Actions) are discarded after the job, and local
   single-database runs delete the fixture table so the next run rebuilds it
   from scratch instead of reusing a seed with dropped columns.

## Primary Metric

- `delete19FieldsMs`: elapsed time for the synchronous bulk field delete
  request.

## Notes

The initial 120s threshold is a guardrail, not a benchmark result; tighten it
after real V1/V2 run history exists. The `x-window-id` header is sent so the
request matches real grid behavior; this case does not replay or restore
through the undo stack.
