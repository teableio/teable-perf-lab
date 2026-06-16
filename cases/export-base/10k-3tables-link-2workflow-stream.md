---
owner: perf-lab
tags:
  - export-base
  - stream
  - records
  - links
enabled: true
---

# export-base/10k-3tables-link-2workflow-stream

## Goal

Measure exporting a base through the product SSE progress path when the base
contains a 10,000-record main table, a 1,000-record linked table, a 100-record
small table, and workflow metadata.

## Seed Phase

Build and cache the same deterministic source-base shape used by duplicate-base:

- `Main 10k`: mixed 20-field table with 10,000 deterministic rows.
- `Linked 1k`: 1,000 rows with a populated link to the main table.
- `Small 100`: 100 deterministic rows.
- 2 workflow definitions when available.

The source base is validated before execute with full scans and link remap
readiness checks.

## Execute Phase

1. Reuse or create the source base and validate it.
2. Measured: call
   `GET /api/base/{baseId}/export-stream?includeData=true`.
3. Read the SSE response until the `done` event and assert no stream error
   events occurred.
4. Verify the stream result includes a `previewUrl`, `baseName`, and `fileName`.

## Primary Metric

- `exportBaseStreamMs`: elapsed time from sending the export stream request
  until the SSE `done` event is received.

## Notes

Current product code selects the export implementation by base status rather
than the same `@UseV2Feature` routing guard used by duplicate/import base. This
case records response headers and progress events but does not assert the
`x-teable-v2-feature` route match for export.
