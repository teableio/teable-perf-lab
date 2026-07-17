---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, single-line-text]
enabled: true
---

# record-update/1k-single-line-text-fields-bulk-update

## Goal

Measure one 1,000-record bulk request that updates the four single-line text
fields in the shared 20-field scalar fixture.

## Seed Phase

Reuse the `mixed-1k-20fields` fixture: 1,000 deterministic rows containing
text, long text, selects, numbers, dates, checkboxes, and rating values.

## Execute Phase

1. Send one `PATCH /api/table/{tableId}/record` request containing `Title`,
   `Owner Text`, `External ID`, and `Source` for all 1,000 records.
2. Assert the response uses the requested V1/V2 `updateRecords` route.
3. Verify rows 1, 500, and 1,000 after the timer stops.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

The response must contain 1,000 ids. The four payload fields must have their
deterministic updated values, while the other 16 fields keep seed values.
