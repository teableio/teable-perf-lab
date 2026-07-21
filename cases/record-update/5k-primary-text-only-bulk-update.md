---
owner: backend-v2
tags: [record-update, bulk-update, 5k, primary-only, scale-up, v1-v2]
enabled: true
---

# record-update/5k-primary-text-only-bulk-update

## Goal

Scale `record-update/1k-primary-text-only-bulk-update` from 1,000 to 5,000 records in one PATCH.

## Seed Phase

Prepare and verify a deterministic 5,000-row table containing only the primary Title field.

## Execute Phase

Send one 5,000-record PATCH and assert V1/V2 `updateRecords` routing plus 5,000 response ids.

## Primary Metric

- `bulkUpdate5kMs`: bulk PATCH request time only; initial `maxMs` is 30,000.

## Verification

Verify rows 1, 2,500, and 5,000 through the real read path, then restore the seed values between sibling runs.

## Notes

Only records per request change from the baseline. The one-field seed remains separate from the mixed 20-field family.
