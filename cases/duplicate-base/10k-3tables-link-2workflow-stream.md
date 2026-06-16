---
owner: perf-lab
tags:
  - duplicate-base
  - stream
  - records
  - links
  - workflows
enabled: true
---

# duplicate-base/10k-3tables-link-2workflow-stream

## Goal

Measure duplicating a base through the product SSE progress path when the base
contains a 10,000-record main table, a 1,000-record linked table, a 100-record
small table, and 2 workflows.

## Seed Phase

Reuse the same dedicated source-base fixture as
`duplicate-base/10k-3tables-link-2workflow`:

- `Main 10k`: mixed 20-field table with 10,000 deterministic rows.
- `Linked 1k`: 1,000 deterministic rows with a populated many-one link to the
  main table.
- `Small 100`: 100 deterministic rows.
- 2 workflow definitions when the runtime automation module is available.

The source base is hash-named and reusable when seed caching is enabled. A
restored fixture must pass the same table, record, link, and workflow readiness
checks before execute.

## Execute Phase

1. Reuse or create the source base and validate it.
2. Measured: call `POST /api/base/duplicate-stream` with `withRecords: true`.
3. Read the SSE response until the `done` event and assert no stream error
   events occurred.
4. Assert duplicate-base routing headers match the requested V1/V2 engine.
5. Verify the duplicated base with the same full scans as the non-stream case:
   main rows, linked-row samples and link target remap, small-table row count,
   and workflow count when available.
6. Permanently delete the duplicated result base.

## Primary Metric

- `duplicateBaseStreamMs`: elapsed time from sending the stream duplicate
  request until the SSE `done` event is received.

Post-stream full-scan verification is emitted separately as
`duplicateBaseFullScanReadyMs` and does not participate in the threshold.

## Notes

This case covers the user-facing duplicate modal path that can show progress.
It differs from `duplicate-base/10k-3tables-link-2workflow`, which measures the
single JSON-response endpoint.
