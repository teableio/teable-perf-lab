---
owner: backend-v2
tags:
  - csv-import
  - import
  - create-table
  - 10k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# csv-import/mixed-10k-20fields-create-table-import

## Goal

Measure CSV import that creates a new table through `POST /api/import/{baseId}`
with 10,000 rows and 20 mixed columns. This covers the product path where a user
uploads a larger CSV file and imports it as a new table.

## Seed Phase

This case has no reusable target table seed. The measured product operation is
the table creation itself, so the runner prepares only deterministic CSV content
before the primary metric starts.

The CSV has 10,000 rows and 20 columns. Values are intentionally compact so this
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
5. Wait for import completion. V1 polls `GET /api/import/status/{tableId}` until
   `completed`; V2 treats the `POST` response as completion because the V2
   `ImportCsvCommand` parses the CSV and inserts the record stream inside the
   awaited request path before returning.
6. Record the table row count at the import completion point.
7. Run SQL count verification and confirm the new table has 10,000 rows.
8. Read configured sample rows and verify imported values.
9. Permanently delete the created table.

## Primary Metric

- `csvCreateTableImportCompletedMs`: elapsed time from submitting
  `POST /api/import/{baseId}` until the import operation reports completion.

For V1, the `POST` request creates the table and enqueues the import chunk job,
so the runner polls `GET /api/import/status/{tableId}` until `completed`. For
V2, the `POST` request returns after the `importCsv` command has written the
records. The runner asserts that assumption by reading the SQL row count once
immediately after the V2 response and failing if it is not 10,000. In both
paths, the runner records the table row count at that completion point.

Readiness checks are still required, but they are reported as verification
diagnostics instead of contributing to the primary threshold metric.

The initial threshold is 60 seconds. It is intentionally loose until the first
local and GitHub Actions V1/V2 sample sets establish the normal range.

## Notes

The runner records import response routing headers such as `x-teable-v2`,
`x-teable-v2-feature`, and `x-teable-v2-reason` so reports can distinguish the
legacy V1 path from the V2 `importCsv` path. For this create-table case, V1 is a
valid baseline run and V2 is treated as failed only if the same product
operation does not route to the expected V2 `importCsv` feature or does not
import the full 10,000 rows with the expected sample values.

`details.import.completion` records the completion signal for the engine under
test: V1 reports `import-status-completed` with the status-poll count and 1 s
poll interval, while V2 reports `post-response-sql-row-count` with the asserted
row count observed immediately after the awaited `POST` response.
