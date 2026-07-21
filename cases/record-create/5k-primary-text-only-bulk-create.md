---
owner: backend-v2
tags: [record-create, bulk-create, 5k, primary-only, scale-up, v1-v2]
enabled: true
---

# record-create/5k-primary-text-only-bulk-create

## Goal

Scale `record-create/1k-primary-text-only-bulk-create` from 1,000 to 5,000 records in one create request.

## Seed Phase

Prepare one empty table containing only the primary Title field and build the deterministic 5,000-record payload before timing.

## Execute Phase

Send one 5,000-record create request and assert V1/V2 `createRecord` routing plus 5,000 response ids.

## Primary Metric

- `bulkCreate5kMs`: create endpoint request time only; initial `maxMs` is 30,000.

## Verification

Check the SQL row count and verify rows 1, 2,500, and 5,000 through the real read path.

## Notes

Only records per request change from the baseline. The one-field seed remains separate from the mixed 20-field family.
