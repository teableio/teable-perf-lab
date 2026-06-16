---
owner: perf-lab
tags:
  - import-base
  - stream
  - records
  - simple
  - v2-only
enabled: true
---

# import-base/v2-only-simple-1x1k-table-stream

## Goal

Measure importing a simple `.tea` base file through the V2 product SSE progress
path when the imported base contains one independent 1,000-record table.

## Seed Phase

Build a deterministic source base with:

- `Simple Table 1k`, a lightweight 4-field table with 1,000 rows.

The source base is reusable through the seed cache after the table passes full
row-count and sample-value readiness checks. During seed, the runner exports the
source base to `.tea`, uploads it once through the attachment flow, and caches
the resulting import `notify` payload for execute runs.

## Execute Phase

1. Reuse the cached import `notify` payload prepared by the seed phase.
2. Call `POST /api/base/import-stream` with `{ spaceId, notify }` and record
   the stream response time as `importBaseStreamMs`.
3. Read the SSE response until the `done` event and assert no stream error
   events occurred.
4. Assert import-base routing headers match V2.
5. Verify the imported table, row count, and deterministic sample values.
6. Permanently delete the imported result base.

## Primary Metric

- `importBaseStreamMs`: elapsed time from sending the import stream request until
  the SSE `done` event is received.

Seed-time exporting/uploading and execute-time full-scan verification are
diagnostics outside the threshold metric.

## Notes

This case is V2-only. The legacy V1 import path is no longer maintained and can
report stream completion before imported table data is ready.
