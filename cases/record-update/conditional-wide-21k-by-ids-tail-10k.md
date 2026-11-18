---
owner: backend-v2
tags:
  - record-update
  - conditional-write
  - concurrency
  - v2-only
enabled: true
---

# record-update/conditional-wide-21k-by-ids-tail-10k

## Goal

Measure one V2 update request over 10,000 wide rows, listed by record id, under memory limits close
to a production pod, and whether a collaborator can keep working meanwhile.

## Seed Phase

- Creates a fresh 21,000-row table in the e2e seed base. Each row stores about
  32 KB of incompressible JSON in a long-text column. The size is an estimate
  until the production row width is measured.
- Signs up a second person and invites them to the base as an editor.

## Execute Phase

- Sends one request to `/api/v2/tables/updateRecords` for the last 10,000 rows.
- While it runs, the collaborator repeatedly updates one row and deletes another
  among the first 1,000 rows.
- Checks the affected-row count and scans the remaining rows without reading the
  payload column.

## Primary Metric

`recordWriteReadyMs`. `heapPeakMb`, `rssPeakMb`, `eventLoopP99Ms` and
`eventLoopMaxMs` report the pressure during the write. Collaborator requests must
answer with a 2xx within 10 seconds.

## Notes

Run this case by exact id with the `production-pod` resource profile, which caps
the Node heap at 2304 MiB and Postgres at 1 GiB. It is excluded from the default
full run because reproducing the failure can end the test process.
