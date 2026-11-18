---
owner: backend-v2
tags:
  - record-delete
  - conditional-write
  - concurrency
  - v2-only
enabled: true
---

# record-delete/conditional-80k-computed-tail-100

## Goal

Measure one V2 delete request that affects the last 100 rows of an 80,000-row table, matched by a filter on an unindexed column,
and whether a collaborator can keep working in the same table meanwhile.

## Seed Phase

- Creates a fresh table in the e2e seed base with sequence, text and amount
  columns. The sequence exists twice: as a plain number and as a unique number,
  which has a database index.
- Inserts 80,000 deterministic rows in batches of 1,000.
- Adds 200 group rows, a many-one link, a formula, a lookup and a rollup, and waits until the rollups are correct.
- Signs up a second person and invites them to the base as an editor.

## Execute Phase

- Sends one request to `/api/v2/tables/deleteRecords`, selecting the rows at the
  end of the table. Deletes the rows; the rollups over them must drop those rows.
- While it runs, the collaborator repeatedly updates one row and deletes another
  among the first 1,000 rows. At least one update and one delete always run.
- Checks the affected-row count in the response, waits for every group rollup to be correct, and then scans every
  remaining row to prove that only the intended rows changed.

## Primary Metric

`recordWriteReadyMs`: the bulk request and every rollup is correct.
Fixture setup, waiting for the collaborator and the final scan are excluded.

`collaboratorUpdate*` and `collaboratorDelete*` report the collaborator's
response times. Success means every request answered with a 2xx within 10
seconds. Any failed or unanswered request fails the case and is counted in
`collaboratorFailedRequests`.

## Notes

V1 is skipped because these request shapes exist only on the V2 endpoints.
The 80,000-row size stays below the point where a conditional update of about
112,000 rows currently exceeds the 16 MB projection message limit.
