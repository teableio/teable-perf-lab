---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, number]
enabled: true
---

# record-update/1k-number-fields-bulk-update

## Goal

Measure numeric validation and storage for decimal, integer, and
percentage-like values in one 1,000-record bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture shared by the scalar
field-family cases.

## Execute Phase

1. Send one bulk PATCH containing only `Amount`, `Quantity`, and `Percent`.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

The three numeric cells must exactly equal their updated values. All 17
omitted fields must retain deterministic seed values.
