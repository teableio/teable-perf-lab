---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, checkbox]
enabled: true
---

# record-update/1k-checkbox-fields-bulk-update

## Goal

Measure boolean/null cell semantics in one 1,000-record bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture, whose `Active` and
`Approved` fields use different boolean distributions.

## Execute Phase

1. Send one bulk PATCH containing only `Active` and `Approved`.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify rows 1, 500, and 1,000 outside the request timer.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

Both checkbox values must match the updated distributions, including the API's
false/null representation. All 18 omitted fields must retain seed values.
