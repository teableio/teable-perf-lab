---
owner: backend-v2
tags:
  - field-create
  - single-select
  - 1k-options
  - v1-v2
enabled: true
---

# field-create/single-select-1k-options

## Goal

Measure the field creation path for adding one single select field with 1,000
deterministic options.

## Seed Phase

- Creates one empty temporary table in the e2e seed base.
- The table has one source field:
  - `Title`: single line text
- Seed hash inputs include the case id, `field-create` runner kind, table shape,
  fixture version, and seed implementation code.

With seed caching enabled, this empty table is named from `seedHash` and reused
across engines and workflow runs. The runner rebuilds it only on a cache miss or
failed `seedReady` validation.

## Execute Phase

1. Restore or build the empty seed table.
2. Verify only the base field exists before measurement.
3. Create single select field `Status 1k Options` with 1,000 deterministic
   choices.
4. Assert the create-field response routing header matches the requested engine:
   `x-teable-v2: false` for V1 and `x-teable-v2: true` for V2.
5. Fetch the table fields and verify the created field type, total option count,
   and option samples at indexes 0, 499, and 999.
6. Clean up execute-only changes. On cached seeds, delete only the created field
   and preserve the empty source table for the next run.

## Primary Metric

- `singleSelectCreateOptionsMs`: single select field creation plus field-read
  verification.

## Notes

This case isolates large select-option metadata creation. It does not insert
records, update cell values, or measure option edits after field creation.
The runner records routing headers such as `x-teable-v2`,
`x-teable-v2-feature`, `x-teable-v2-reason`, and `traceparent` in the artifact
so reports can distinguish the V1 and V2 execution paths.
