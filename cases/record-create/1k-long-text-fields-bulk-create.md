---
owner: backend-v2
tags:
  - record-create
  - bulk-create
  - 1k
  - long-text
  - partial-payload
  - v1-v2
enabled: true
---

# record-create/1k-long-text-fields-bulk-create

## Goal

Measure one 1,000-record create request containing only the three long-text
fields of a 20-field mixed table.

## Seed Phase

Reuse the shared empty 20-field mixed table and canonical payload. The execute
payload projects `Description`, `Notes`, and `Comment` only.

## Execute Phase

Create 1,000 typed records in one request and assert V1/V2 `createRecord`
routing plus 1,000 response IDs. Verify the SQL row count and three deterministic
records across all 20 fields; the seventeen omitted fields must remain empty.

## Primary Metric

- `bulkCreate1kMs`: create endpoint request time only; initial `maxMs` is 6,000.

## Notes

Payload construction, final-state reads, and shared-seed cleanup are excluded
from the primary metric.
