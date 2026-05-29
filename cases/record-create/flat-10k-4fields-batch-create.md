---
owner: backend-v2
tags:
  - record-create
  - table-operation
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# record-create/flat-10k-4fields-batch-create

## Goal

Measure the OpenAPI record creation path for inserting 10,000 deterministic
records into an empty four-field table through `POST /api/table/{tableId}/record`.

## Seed Phase

- Creates one temporary empty table in the e2e seed base.
- The table has `Name`, `Index`, `Group`, and `Payload` fields.
- Builds deterministic create payloads in 1,000-record batches.
- Seed hash inputs should include the case id, runner kind, field layout, row
  count, batch size, generator config, fixture version, and runner seed code.

The seed table is intentionally empty. The records are created during the
measured execute phase.

## Execute Phase

1. Start the primary timer after the empty table and payload batches are ready.
2. Call `POST /record` ten times with 1,000 records per request.
3. Stop the primary timer after the final batch response returns.
4. Full scan all 10,000 records and verify deterministic values.
5. Permanently delete the temporary table.

## Primary Metric

- `create10kMs`: elapsed time for the ten batched create-record requests.

## Notes

The fixture preparation and post-create full scan are outside the primary
metric. The operation mirrors a client or tool importing many records through
the standard record API instead of the grid paste API.
