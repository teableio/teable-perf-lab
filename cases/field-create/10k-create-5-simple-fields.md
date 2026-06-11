---
owner: backend-v2
tags:
  - field-create
  - 10k
  - simple-fields
  - v1-v2
enabled: true
---

# field-create/10k-create-5-simple-fields

## Goal

Measure create-request latency for adding 5 simple fields to a 10,000-record
table. This case is paired with
`field-create/10k-create-5-formula-fields` to compare whether the
request latency layer is close when formula calculation completion is not
measured.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table starts with one source field:
  - `Title`: single line text
- Inserts 10,000 deterministic title records in 1,000-record batches.
- Verifies the source table is ready by full-scanning the 10,000 records and
  checking that no target create fields already exist.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. The runner deletes execute-created fields during cached local
  runs so the table can be reused.

## Execute Phase

1. Start the primary timer only after the 10k source table is ready.
2. Inside one `create5SimpleFields` measurement, call
   `POST /api/table/{tableId}/field` sequentially for long text, number, date,
   checkbox, and single select fields.
3. Stop the primary timer when the fifth create-field response returns.
4. For each create response, assert the `x-teable-v2` routing header matches the
   requested engine.
5. After the primary timer stops, fetch table fields and verify the created
   field type and option metadata.

## Primary Metric

- `create5SimpleFieldsMs`: elapsed time from starting the first external
  create-field request through completion of the fifth create-field response.

## Notes

Verification runs after the primary measurement and is not included in
`create5SimpleFieldsMs`, thresholds, or phases. This case does not wait for any
background calculation readiness.
