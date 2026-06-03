---
owner: backend-v2
tags:
  - record-update
  - table-operation
  - bulk-update
  - 1k
  - v1-v2
  - 20fields
  - mixed-fields
enabled: true
---

# record-update/mixed-1k-20fields-bulk-update

## Goal

Measure OpenAPI bulk record update performance for updating 1,000 existing
records across 20 mixed fields through `PATCH /api/table/{tableId}/record`.

This case targets the multi-record update endpoint directly. It avoids grid
selection, paste, computed fields, and undo/redo so V1 and V2 compare the same
bulk update path.

## Seed Phase

- Creates one reusable table in the e2e seed base.
- Uses the same 20 mixed-field layout as the mixed CSV import case: text, long
  text, single select, multiple select, number, date, checkbox, and rating.
- Seeds 1,000 deterministic records in one 1,000-record batch with `seed-`
  values.
- Resolves field ids and the first grid view id.
- On cache hit, reuses cached record ids from the seed table metadata.

## Execute Phase

1. Build one update payload for all 1,000 records and all 20 fields.
2. Start the primary timer.
3. Call `PATCH /api/table/{tableId}/record` with `fieldKeyType: "id"`,
   `typecast: false`, `records`, and a stable `X-Window-Id`.
4. Read rows 1, 500, and 1,000, then verify their record ids and all 20 mixed
   fields match the deterministic `updated-` values.
5. Stop the primary timer after update response and sample verification
   complete.
6. Cleanup restores reusable cached tables back to seed values in local
   single-database runs. Isolated execute databases are left for job teardown.

## Primary Metric

- `bulkUpdate1kMs`: elapsed time for the bulk update request plus sample
  verification.

## Verification

- The update response must contain 1,000 updated record ids.
- Rows 1, 500, and 1,000 must keep their cached record ids.
- Rows 1, 500, and 1,000 are verified as typed samples against the deterministic
  update payload.

## Notes

The workload is intentionally sized at 1,000 rows, matching the V1 batch update
chunk boundary while keeping the first record-update baseline easy to interpret.
