---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, narrow-table]
enabled: true
---

# record-update/1k-primary-text-only-bulk-update

## Goal

Establish the narrowest 1,000-record scalar update baseline: one `Title` field
in the table and one field in every request record.

## Seed Phase

Create one reusable one-field table with 1,000 deterministic `seed-title-`
values and cached record ids.

## Execute Phase

1. Send one bulk PATCH containing only updated `Title` values.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

All three sample titles and their record ids must match the deterministic
updated state. Seed preparation, verification, and restoration are unmeasured.
