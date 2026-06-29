---
owner: backend-v2
tags:
  - field
  - restore
  - trash
  - stream
  - 10k
  - v1-v2
  - mixed-fields
enabled: true
---

# field-restore/10k-description-field

## Goal

Measure restoring one deleted populated text field on a 10,000-row mixed table,
including the field schema restore and every row's cell value restoration.

This catches regressions in the field trash restore path. V1 runs the legacy
direct restore endpoint, while V2 runs the product field restore stream endpoint
added for real-time progress.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table uses the shared 10k mixed-record fixture: 20 fields covering text,
  long text, select, number, date, checkbox, rating, and related scalar types.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Verifies seed readiness with a full row-count scan and sample text checks.
- The measured field is `Description`, a non-primary text field whose expected
  value for every row is derived from the row number.

## Execute Phase

1. Start after the 10k source table has passed `seedReady`.
2. Setup, outside the primary timer: delete only the `Description` field through
   `DELETE /api/table/{tableId}/field?fieldIds=...`, then resolve the field
   trash item from `GET /api/trash/items?resourceType=table&resourceId={tableId}`.
3. Measured V1 behavior: call `POST /api/trash/restore/{trashId}?tableId=...`
   and stop when the direct response returns.
4. Measured V2 behavior: call
   `POST /api/trash/restore-field/{trashId}/stream?tableId=...` and stop when
   the stream emits `done`.
5. Capture routing headers and fail if the engine route does not match the
   requested V1/V2 run. V2 additionally requires the `x-teable-v2-feature`
   header to equal `createField`.
6. Verify through the real records API that the restored field is listed again
   and that all 10,000 restored `Description` values match the deterministic
   seed values.

## Primary Metric

- `restoreFieldMs`: elapsed time for the product restore operation after the
  field trash item already exists.

The metric intentionally excludes seed preparation, the delete setup that
creates the trash item, post-restore full-scan verification, and cleanup. V1 and
V2 use different transport shapes because that is the product behavior under
test: direct legacy restore for V1, stream restore with progress for V2.

## Notes

The initial 120s threshold is a wide guardrail for first-run correctness and
artifact collection. Tighten it after the case has enough CI history for both
engines. Do not compare this metric as a pure direct-to-direct transport
benchmark; use it as the end-to-end field restore user behavior comparison.
