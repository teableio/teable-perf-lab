---
owner: backend-v2
tags:
  - field-create
  - 10k
  - formula-fields
  - formula
  - v1-v2
enabled: true
---

# field-create/10k-create-5-formula-fields

## Goal

Measure create-request latency for adding 5 formula fields to a 10,000-record
table, then separately verify how long it takes after the create responses for
the formula values to be correct in the underlying physical table columns. The
create-request metric can be compared with
`field-create/10k-create-5-simple-fields` at the request latency
layer, while the ready metric captures post-create storage readiness without
using records API pagination as the readiness signal.

## Seed Phase

- Creates one temporary table in the e2e seed base.
- The table starts with four source fields:
  - `Title`: single line text
  - `A`: number
  - `B`: number
  - `C`: number
- Inserts 10,000 deterministic numeric-sequence records in 1,000-record
  batches.
- Verifies the source table is ready by full-scanning the 10,000 records and
  checking that no target formula fields already exist.
- When seed cache is enabled, the hash-derived source table is reused across
  workflow runs. The runner deletes execute-created fields during cached local
  runs so the table can be reused.

## Execute Phase

1. Start the primary timer only after the 10k source table is ready.
2. Resolve the base field ids before measurement so formula expressions can use
   the public create-field payload shape expected by Teable.
3. Inside one `create5ComputedFields` measurement, call
   `POST /api/table/{tableId}/field` sequentially for these formula fields:
   - `({A} * {B}) + {C}`
   - `{A} + {B} + {C}`
   - `({A} * {C}) + {B}`
   - `{A} + ({B} * {C})`
   - `({A} * 3) + ({B} * 5) + ({C} * 7)`
4. Stop the primary timer when the fifth create-field response returns.
5. For each create response, assert the `x-teable-v2` routing header matches the
   requested engine.
6. After the fifth create-field response returns, start
   `computedBackfillReady`. Resolve the table `dbTableName` and the dependency
   and formula `dbFieldName` values from table metadata, then poll one
   aggregate SQL query until all 10,000 physical rows have non-null formula
   values and zero formula mismatches.
7. Fetch table fields and verify the created field type and compiled expression
   metadata.

## Primary Metric

- `create5ComputedFieldsMs`: elapsed time from starting the first external
  create-field request through completion of the fifth create-field response.
- `computedBackfillReadyMs`: elapsed time from after all 5 create-field
  responses have returned until a DB aggregate check confirms all 10,000 stored
  rows have correct values for all 5 formula fields.

## Notes

The ready check runs after the primary measurement and is not included in
`create5ComputedFieldsMs` or the primary threshold.
`computedBackfillReadyMs` intentionally does not include the 5 create-field
request durations; it starts only after those requests have completed.

This metric should not be read as background queue duration by default. In the
current Teable implementation, V1 formula field creation computes existing
record values inside the create transaction. V2 field creation routes through
`CreateFieldCommand` and table update flow; for these 5 sequential single-field
creates on exactly 10,000 rows, the default computed field backfill config is
sync mode with a 10,000-row hybrid threshold. If the first DB aggregate check
already reports `nulls=0` and `mismatches=0`, `computedBackfillReadyMs` should
be close to zero; that proves the stored values were already ready when the
fifth POST returned.

The ready SQL counts total rows, nulls, and mismatches per formula column in
the database, using the dependency columns `A`, `B`, and `C` to recompute the
expected values. It does not page 10,000 records through the records API as the
readiness signal.
