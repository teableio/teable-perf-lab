---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, wide-table, narrow-payload]
enabled: true
---

# record-update/1k-wide-table-title-only-bulk-update

## Goal

Separate wide-schema planning cost from payload width by updating only `Title`
in the same 20-field fixture used by the aggregate mixed update case.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture and its cached record ids.

## Execute Phase

1. Send one bulk PATCH with 1,000 records and only `Title` in each fields map.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify all 20 fields on rows 1, 500, and 1,000 after timing.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

`Title` must have its updated value. The other 19 fields must keep their seed
values, proving omitted cells are neither cleared nor overwritten.
