---
owner: backend-v2
tags:
  - record-create
  - openapi
  - bulk-create
  - 1k
  - 20fields
  - mixed-fields
  - select-fields
  - v1-v2
enabled: true
---

# record-create/mixed-1k-20fields-bulk-create

## Goal

Measure `POST /api/table/{tableId}/record` for creating 1,000 typed records in
one request against an empty 20-field mixed table.

This case targets the OpenAPI record create path directly. It does not go
through grid paste or the CSV import pipeline.

## Seed Phase

- Creates one temporary empty table in the e2e seed base.
- The table has the same 20 mixed fields as the CSV import mixed case:
  - single line text: `Title`, `Owner Text`, `External ID`, `Source`
  - long text: `Description`, `Notes`, `Comment`
  - single select: `Status`, `Priority`, `Category`
  - multiple select: `Tags`, `Labels`
  - number: `Amount`, `Quantity`, `Percent`
  - date: `Start Date`, `Due Date`
  - checkbox: `Active`, `Approved`
  - rating: `Score`
- Select choices, rating options, and UTC date formatting match
  `csv-import/mixed-10k-20fields-inplace-import`.
- Resolves the first grid view and all field IDs.
- Builds a deterministic 1,000-row typed create payload before the primary
  timer starts.

The canonical full-schema payload and empty table are shared with the partial
payload matrix through one seed identity. The created records are execute data
because record creation is the measured operation. Cleanup restores the table
to its empty state between shared sibling cases, including inside an isolated
multi-case execute job.

## Execute Phase

1. Start the primary timer.
2. Call `POST /api/table/{tableId}/record` with:
   - `fieldKeyType: "name"`
   - `typecast: false`
   - `records`: 1,000 deterministic typed records
3. Stop the primary timer after the create endpoint response.
4. Assert the response routing matches the requested V1/V2 engine.
5. Run SQL count verification separately and confirm the table has 1,000 rows.
6. Read rows 1, 500, and 1,000 through the records API, match their response
   IDs, and verify all 20 deterministic values.
7. Cleanup removes the records created during execute and revalidates the
   shared empty seed; non-reusable temporary tables are deleted.

## Primary Metric

- `bulkCreate1kMs`: elapsed time for the create endpoint request only.

Setup diagnostics such as table creation, field resolution, and payload
construction are recorded separately and are not counted as the primary metric.
SQL count and sample verification are recorded separately as `verifyCreatedMs`.

## Notes

This case keeps `typecast: false` so it measures typed record write cost rather
than string conversion. The 1,000-row size matches one default V1 create chunk
while remaining directly comparable to V2 bulk record mutation.
