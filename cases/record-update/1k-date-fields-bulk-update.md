---
owner: backend-v2
tags: [record-update, bulk-update, 1k, v1-v2, date]
enabled: true
---

# record-update/1k-date-fields-bulk-update

## Goal

Measure parsing, normalization, and storage of UTC date-only cells in one
1,000-record bulk update.

## Seed Phase

Reuse the deterministic `mixed-1k-20fields` fixture shared by the scalar
field-family cases.

## Execute Phase

1. Send one bulk PATCH containing only `Start Date` and `Due Date`, each moved
   deterministically by one day.
2. Assert the requested V1/V2 `updateRecords` route and 1,000 response ids.
3. Verify normalized values on rows 1, 500, and 1,000 after timing.

## Primary Metric

- `bulkUpdate1kMs`: bulk PATCH request time only; initial `maxMs` is 8,000.

## Verification

Both dates must normalize to the expected day. All 18 omitted fields must keep
their seed values.
