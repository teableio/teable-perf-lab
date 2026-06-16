---
owner: perf-lab
tags:
  - import-base
  - stream
  - records
  - workflows
enabled: true
---

# import-base/3x1k-3tables-2workflow-stream

## Goal

Measure importing a `.tea` base file through the product SSE progress path when
the imported base contains three independent 1,000-record tables and workflow
metadata.

## Seed Phase

Build a deterministic source base with:

- `Table A 1k`, a lightweight 4-field table with 1,000 rows;
- `Table B 1k`, a lightweight 4-field table with 1,000 rows;
- `Table C 1k`, a lightweight 4-field table with 1,000 rows;
- workflow definitions when the automation module is available.

The source base is reusable through the seed cache after all three tables pass
full row-count and sample-value readiness checks.

## Execute Phase

1. Export the ready source base through `GET /api/base/{baseId}/export-stream`
   as setup, outside the primary metric.
2. Download the exported `.tea` file, upload it through the product attachment
   signature/upload/notify flow, and build the `notify` object expected by base
   import.
3. Call `POST /api/base/import-stream` with `{ spaceId, notify }` and record
   the stream response time as `importBaseStreamMs`.
4. Read the SSE response until the `done` event and assert no stream error
   events occurred.
5. Assert import-base routing headers match the requested V1/V2 engine.
6. Verify all three imported tables, row counts, and deterministic sample values.
   Workflow count is not asserted because imported workflow behavior is
   runtime/module dependent.
7. Permanently delete the imported result base.

## Acceptance Point

- V2 primary metric: `importBaseStreamMs`, elapsed time from sending the import
  stream request until the SSE `done` event is received.
- V1 primary metric: `importBaseTotalReadyMs`, elapsed time from sending the
  import stream request until all three imported tables are readable with 1,000
  records each.

## Diagnostic Metrics

- `importBaseStreamMs`: stream completion time. For V1 this is diagnostic
  because legacy import can return before queued table data is fully imported.
- `importBaseFullScanReadyMs`: post-`done` wait/verification time until the
  imported base is fully usable.
- `importBaseTotalReadyMs`: stream time plus post-`done` full-scan readiness.

Exporting, downloading, uploading, and attachment notify are diagnostics outside
the threshold metric.

## Notes

This case follows the same product path as the import UI: export file as setup,
upload as an import attachment, then import with SSE progress. The fixture avoids
link fields so it measures bulk base import of multiple large tables without
mixing in legacy V1 link-import behavior.

The row count is deliberately 1,000 per table. Local V1 validation of the
original 3x10k workload and a 3x2k probe returned SSE `done` quickly but did not
make all table data readable within the readiness window, so the runnable V1/V2
comparison uses a stable product-path workload.
