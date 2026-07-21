---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 5k
  - checkbox
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/5k-checkbox-fields-bulk-create

## Goal

Measure one 5,000-record create request containing the same two checkbox fields
as the 1k baseline. Only the record count changes.

## Seed Phase

Create an empty 20-field mixed table and build a deterministic 5,000-record
payload projected to `Active` and `Approved`.

## Execute Phase

Create all 5,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 5,000 response IDs.

## Primary Metric

- `bulkCreate5kMs`: create endpoint request time only; initial `maxMs` is
  30,000.

## Verification

Verify the SQL row count, checkbox values on rows 1, 2,500, and 5,000, and that
the other eighteen fields remain empty.
