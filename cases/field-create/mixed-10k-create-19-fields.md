---
owner: backend-v2
tags:
  - field-create
  - 10k
  - 20fields
  - mixed-fields
  - v1-v2
enabled: true
---

# field-create/mixed-10k-create-19-fields

## Goal

Measure the external field creation path for adding 19 mixed-type fields to a
10,000-row table.

The public OpenAPI only exposes single-field
`POST /api/table/{tableId}/field`. This case intentionally models real external
behavior by sending 19 sequential create-field requests inside one measurement
window; it does not add or call a product bulk-create API.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table starts with only `Title`, matching the primary field from the shared
  20-field mixed shape used by record undo/redo and field delete cases.
- Inserts 10,000 deterministic title-only records in 1,000-record batches.
- Verifies the source table is ready by full-scanning the 10,000 records and
  checking that no target create fields already exist.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. The runner deletes any execute-created fields during cached
  local runs so the table can be reused.

## Execute Phase

1. Start the primary timer only after the 10k source table is ready.
2. Inside one `create19Fields` measurement, call
   `POST /api/table/{tableId}/field` sequentially for the 19 non-Title mixed
   fields: long text, single select, multiple select, number, date, checkbox,
   rating, and text variants.
3. Stop the primary timer when the 19th create-field response returns.
4. For each create response, assert the `x-teable-v2` routing header matches the
   requested engine and record the routing header summary in run details.
5. After the primary timer stops, fetch table fields and verify all 19 target
   fields exist with the expected type and select/rating/date option metadata.

## Primary Metric

- `create19FieldsMs`: elapsed time from starting the first external create-field
  request through completion of the 19th create-field response.

## Notes

Verification runs after the primary measurement and is not included in
`create19FieldsMs`, thresholds, or phases. The initial 180s threshold is a
guardrail until real V1/V2 history is available.
