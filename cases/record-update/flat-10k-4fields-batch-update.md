---
owner: backend-v2
tags:
  - record-update
  - table-operation
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# record-update/flat-10k-4fields-batch-update

## Goal

Measure the OpenAPI bulk update path for changing 10,000 existing records in a
four-field table through `PATCH /api/table/{tableId}/record`.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- Seeds 10,000 deterministic records in 1,000-record batches.
- Keeps the created record ids needed to build deterministic update batches.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.

## Execute Phase

1. Start the primary timer after the source table and record-id list are ready.
2. Call `PATCH /record` ten times with 1,000 record updates per request.
3. Update all four fields to deterministic replacement values.
4. Stop the primary timer after the final update response returns.
5. Full scan all 10,000 records and verify the updated values.
6. Permanently delete the temporary table.

## Primary Metric

- `update10kMs`: elapsed time for the ten batched update-record requests.

## Notes

The seed table construction is reported as `prepareMs` and is not part of the
primary metric. This case is meant to catch regressions in high-volume table
edits and API tool updates.
