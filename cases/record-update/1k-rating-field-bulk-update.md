---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, rating]
enabled: true
---

# record-update/1k-rating-field-bulk-update

## Goal

Measure bounded rating validation and storage in one 1,000-record bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture, whose five-star `Score`
cycles from 1 through 5.

## Execute Phase

1. Rotate only `Score` by one value in one bulk PATCH.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

`Score` must equal its updated cycle value. All 19 omitted fields must retain
deterministic seed values.
