---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, multiple-select]
enabled: true
---

# record-update/1k-multiple-select-fields-bulk-update

## Goal

Measure array validation and multiple-select serialization in one 1,000-record
bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture with two-choice `Tags` and
`Labels` arrays.

## Execute Phase

1. Rotate only `Tags` and `Labels` in one bulk PATCH.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

Both ordered choice arrays must equal the updated values. All 18 omitted
fields must retain deterministic seed values.
