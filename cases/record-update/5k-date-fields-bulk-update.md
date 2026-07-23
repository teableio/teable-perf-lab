---
owner: backend-v2
tags: [record-update, bulk-update, 5k, scale-up, v1-v2]
enabled: true
---

# record-update/5k-date-fields-bulk-update

## Goal

Scale `record-update/1k-date-fields-bulk-update` from 1,000 to 5,000 records while preserving its two-date-field projection and one-request update behavior.

## Seed Phase

Reuse the shared deterministic 5,000-row, 20-field mixed fixture and verify it before timing.

## Execute Phase

Send one 5,000-record PATCH from a worker-owned HTTP client and assert V1/V2
`updateRecords` routing plus 5,000 response ids. The worker keeps response
receipt and JSON parsing off the Nest/Vitest event loop, matching an external
client instead of racing V2 after-response projections in the same process.

## Primary Metric

- `bulkUpdate5kMs`: bulk PATCH request time only; initial `maxMs` is 30,000.

## Verification

Verify rows 1, 2,500, and 5,000 and prove all omitted fields retain their deterministic seed values outside the request timer.

## Notes

Only records per request change from the baseline. Shared-seed cleanup restores
and revalidates the fixture between siblings. The workflow-level `samples`
input does not repeat this mutation case; each engine currently records one
measured PATCH.
