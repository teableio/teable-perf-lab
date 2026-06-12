---
owner: backend-v2
tags:
  - csv-import
  - import
  - create-table
  - 1k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# csv-import/mixed-1k-20fields-create-table-import

## Goal

Measure CSV import that creates a new table through `POST /api/import/{baseId}`.
This covers the product path where a user uploads a CSV file and imports it as a
new table. V1 and V2 runs execute the same user-facing behavior, with the same
CSV data, endpoint shape, readiness checks, and cleanup.

T4883 adds one important V2 correctness signal for this shared behavior: in a V2
run, the unchanged CSV create-table import path must route to the V2 `importCsv`
implementation instead of falling back to the legacy V1 import path.

## Seed Phase

This case has no reusable target table seed. The measured product operation is
the table creation itself, so the runner prepares only deterministic CSV content
before the primary metric starts.

The CSV has 1,000 rows and 20 columns. Values are intentionally compact so this
case measures create-table import routing and readiness, not large-cell or
large-file streaming behavior. A representative subset of fields carries values;
the remaining columns are present but empty:

- text: `Title`, `Owner Text`, `External ID`, `Source`
- long text payloads: `Description`, `Notes`, `Comment`
- select-like text values: `Status`, `Priority`, `Category`, `Tags`, `Labels`
- numeric values: `Amount`, `Quantity`, `Percent`, `Score`
- date values: `Start Date`, `Due Date`
- checkbox-like values: `Active`, `Approved`

The runner uploads the CSV as an import attachment and runs analyze before the
primary metric starts. Upload and analyze time are reported as setup diagnostics,
not as the primary metric.

## Execute Phase

1. Start the primary timer after CSV upload and analyze are ready.
2. Call `POST /api/import/{baseId}` with:
   - `attachmentUrl`: uploaded CSV URL
   - `fileType: "csv"`
   - `tz: "UTC"`
   - `worksheets`: one imported worksheet using the analyzed column types and
     zero-based source column indexes
3. In V2 runs, assert the response routing headers show feature `importCsv` and
   do not report `x-teable-v2-reason: no_feature`.
4. Resolve the created table, grid view, fields, and database table name from
   the response/read path.
5. Record the engine-specific import completion signal. V1 polls
   `GET /api/import/status/{tableId}` until `completed`; V2 asserts the SQL row
   count immediately after the awaited `POST` response because the V2
   `ImportCsvCommand` writes records before returning.
6. Run SQL count verification and confirm the new table has 1,000 rows.
7. Read configured sample rows and verify imported values.
8. Permanently delete the created table.

## Primary Metric

- `csvCreateTableImportReadyMs`: elapsed time for the `POST` import request plus
  SQL count readiness verification and configured sample-row checks.

The initial threshold is 12 seconds. It is intentionally loose until the first
GitHub Actions V1/V2 sample set establishes the normal range.

## Notes

The runner records import response routing headers such as `x-teable-v2`,
`x-teable-v2-feature`, and `x-teable-v2-reason` so reports can distinguish the
legacy V1 path from the V2 `importCsv` path. For this create-table case, V1 is a
valid baseline run and V2 is treated as failed only if the same product operation
does not route to the expected V2 `importCsv` feature or does not import the full
1,000 rows with the expected sample values.

`details.import.completion` records the completion signal for the engine under
test so artifacts explain whether completion came from V1 status polling or the
V2 post-response SQL row-count assertion. The primary metric remains
`csvCreateTableImportReadyMs`, so sample-row verification still contributes to
the threshold metric for this 1k readiness case.

The V2 completion boundary is backed by the read-only `teable-ee` import path:
`community/packages/v2/contract-http-implementation/src/handlers/tables/importCsv.ts:24`
awaits `commandBus.execute<ImportCsvCommand, ImportCsvResult>(...)` before
building the HTTP response, so the endpoint is not fire-and-forget. Inside the
command handler,
`community/packages/v2/core/src/commands/ImportCsvHandler.ts:283` awaits
`tableRecordRepository.insertManyStream(...)` in the data transaction, then
`community/packages/v2/core/src/commands/ImportCsvHandler.ts:339-349` completes
the schema operation and publishes events only after insertion has finished.
