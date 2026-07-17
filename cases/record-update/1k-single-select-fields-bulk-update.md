---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, single-select]
enabled: true
---

# record-update/1k-single-select-fields-bulk-update

## Goal

Measure option lookup and single-select serialization in one 1,000-record
bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture with three choices each
for `Status`, `Priority`, and `Category`.

## Execute Phase

1. Rotate only the three single-select values by one choice in one bulk PATCH.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

The three choice names must exactly match the updated rotation. All 17 omitted
fields must retain deterministic seed values.
