---
owner: backend-v2
tags: [record-create, bulk-create, 5k, scale-up, v1-v2]
enabled: true
---

# record-create/5k-number-fields-bulk-create

## Goal

Scale `record-create/1k-number-fields-bulk-create` from 1,000 to 5,000 records while preserving the same field projection and one-request create behavior.

## Seed Phase

Reuse the shared empty deterministic 20-field mixed-table shape for the 5k create family. The typed 5,000-record payload is prepared before the primary timer.

## Execute Phase

Send one 5,000-record create request, assert V1/V2 `createRecord` routing, and require 5,000 response ids.

## Primary Metric

- `bulkCreate5kMs`: create endpoint request time only; initial `maxMs` is 30,000.

## Verification

Check the SQL row count, scan the promised final state, verify rows 1, 2,500, and 5,000, and prove omitted fields remain empty.

## Notes

Only records per request change from the baseline. The initial threshold is a loose first-run guardrail.
