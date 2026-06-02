---
owner: backend-v2
tags:
  - csv-import
  - import
  - inplace-import
  - 10k
  - 20fields
  - mixed-fields
  - select-fields
  - v1-v2
enabled: true
---

# csv-import/mixed-10k-20fields-inplace-import

## Goal

Measure CSV import into an existing mixed 20-field table through
`PATCH /api/import/{baseId}/{tableId}`. This covers the product path where a
user uploads CSV data and appends it to a table whose field types already exist.

## Seed Phase

- Creates one reusable empty table in the e2e seed base. When seed cache is
  enabled, the table name includes the runner seed hash and can be restored from
  the workflow seed DB dump.
- The table has 20 fields:
  - single line text: `Title`, `Owner Text`, `External ID`, `Source`
  - long text: `Description`, `Notes`, `Comment`
  - single select: `Status`, `Priority`, `Category`
  - multiple select: `Tags`, `Labels`
  - number: `Amount`, `Quantity`, `Percent`
  - date: `Start Date`, `Due Date`
  - checkbox: `Active`, `Approved`
  - rating: `Score`
- Builds deterministic CSV content with 10,000 rows and 20 columns.
- Uploads the CSV as an import attachment and runs analyze before the primary
  metric starts. The attachment URL and analyze columns are stored in table
  metadata on a best-effort basis; if the cached URL is invalid, the runner
  re-uploads and re-analyzes the same deterministic CSV.

The seed phase intentionally leaves the target table empty. The measured
operation is the import append itself.

## Execute Phase

1. Start the primary timer after the target table, CSV upload, and analyze step
   are ready.
2. Call `PATCH /api/import/{baseId}/{tableId}` with:
   - `attachmentUrl`: uploaded CSV URL
   - `fileType: "csv"`
   - `insertConfig.excludeFirstRow: true`
   - `insertConfig.sourceWorkSheetKey: "Import Table"`
   - `insertConfig.sourceColumnMap`: target field IDs mapped to zero-based CSV
     column indexes
3. Run SQL count verification through `/base/{baseId}/sql-query` and confirm
   the target table has 10,000 rows.
4. Read configured sample rows and verify imported typed values.
5. Permanently delete the temporary table.

## Primary Metric

- `csvInplaceImportReadyMs`: elapsed time for the `PATCH` import request plus
  SQL count readiness verification and configured sample-row checks.

Setup phases such as table creation, upload, and analyze are recorded as
diagnostics and are not included in the primary metric.

## Notes

The runner records import response routing headers such as `x-teable-v2`,
`x-teable-v2-feature`, and `x-teable-v2-reason` so reports can distinguish the
legacy path from the V2 `importRecords` path.
