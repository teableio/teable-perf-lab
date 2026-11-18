---
owner: backend-v2
tags:
  - record-update
  - conditional-write
  - 20k
  - v2-only
enabled: true
---

# record-update/conditional-20k-indexed-tail-18k

## Goal

Measure one V2 update request that affects the last 18,000 rows of a 20,000-row table, matched by a filter on an indexed column.

## Seed Phase

- Creates a fresh table in the e2e seed base with sequence, text and amount
  columns. The sequence exists twice: as a plain number and as a unique number,
  which has a database index.
- Inserts 20,000 deterministic rows in batches of 1,000.

## Execute Phase

- Sends one request to `/api/v2/tables/updateRecords`, selecting the rows at the
  end of the table. Writes one text column.
- Checks the affected-row count in the response and then scans every
  remaining row to prove that only the selected rows changed.

## Primary Metric

`recordWriteReadyMs`: from sending the request until the write is complete.
Fixture setup and the final scan are excluded.

## Notes

V1 is skipped because these request shapes exist only on the V2 endpoints.
The guardrail is deliberately loose until nightly history gives a baseline.
