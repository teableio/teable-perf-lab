---
owner: backend-v2
tags: [record-update, bulk-update, 5k, v1-v2, checkbox]
enabled: true
---

# record-update/5k-checkbox-fields-bulk-update

## Goal

Measure one 5,000-record checkbox update. This keeps the 1k baseline's table
shape and partial payload while increasing only the records in the request.

## Seed Phase

Build the deterministic 5,000-row mixed fixture in 1,000-row setup batches.

## Execute Phase

1. Send one bulk PATCH containing `Active` and `Approved` for all 5,000 rows.
2. Assert the requested V1/V2 `updateRecords` route and 5,000 response IDs.
3. Verify rows 1, 2,500, and 5,000 outside the request timer.

## Primary Metric

- `bulkUpdate5kMs`: bulk PATCH request time only; initial `maxMs` is 30,000.

## Verification

Both checkbox values must match the updated distributions. All eighteen omitted
fields must retain their seed values.
