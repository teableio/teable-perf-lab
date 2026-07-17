# Autonomous Perf Cases — Batch 07

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and replace any field-family shape that cannot produce deterministic,
cross-engine values.

## Batch Goal

Turn the single aggregate
`record-create/mixed-1k-20fields-bulk-create` signal into an independently
diagnosable scalar-field matrix. The existing case proves one 1,000-record,
20-field request, but it cannot identify whether a regression comes from text,
select, number, date, checkbox, rating, payload width, or table-schema width.

The ten new cases all use `POST /api/table/{tableId}/record`, create exactly
1,000 records in one request, assert V1/V2 `createRecord` routing, require 1,000
response record ids, verify the SQL row count, and verify the first, middle, and
last created records through the normal records API. Nine cases use the exact
existing 20-field schema so field-family requests are comparable without
schema-shape drift. Every omitted field must remain empty; a fast request that
accidentally populates or shifts an omitted cell is a failure.

The runner may add optional `createFieldNames` and `seedIdentity` config. The
payload selector affects only the measured request and created-state
expectation; it must not enter the seed config. The empty-table seed may cache a
canonical full-schema payload and project it immediately before execute so the
shared seed identity does not thrash table metadata between cases. Cases 1-8
and 10, plus the existing aggregate case, use one explicit
`mixed-1k-20fields` seed identity. That makes the seed job build one wide empty
fixture and one narrow empty fixture instead of ten nearly identical tables.

Shared mutable fixtures must also remain reusable inside one isolated execute
process. When `seedIdentity` is present, record-create cleanup must delete the
1,000 execute-created records and revalidate the empty table even when
`PERF_LAB_EXECUTE_DB_ISOLATED=true`; the isolated short-circuit remains valid
for cases without sibling sharing. Apply the same rule to the Batch 06
record-update siblings so one selected case cannot dirty the shared fixture and
force later cases to rebuild it. Cleanup and verification remain outside the
primary metric.

## Case 1: `record-create/1k-single-line-text-fields-bulk-create`

- **Goal**: isolate serialization and validation of four single-line text
  fields, including the primary field.
- **Seed Phase**: the shared deterministic empty 20-field mixed table plus a
  canonical 1,000-row payload built before timing.
- **Execute Phase**: create 1,000 records carrying only the four single-line
  text fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exactly 1,000 response ids; exact text values on rows 1,
  500, and 1,000; the other sixteen fields empty.

## Case 2: `record-create/1k-long-text-fields-bulk-create`

- **Goal**: isolate larger string payloads and long-text cell serialization.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the three long-text
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact long-text samples plus all seventeen omitted fields
  empty.

## Case 3: `record-create/1k-number-fields-bulk-create`

- **Goal**: isolate numeric validation and storage across decimal, integer, and
  percentage-like values.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the three number
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact numeric samples plus all seventeen omitted fields
  empty.

## Case 4: `record-create/1k-date-fields-bulk-create`

- **Goal**: isolate date parsing, normalization, and storage.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the two UTC date
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: normalized date samples plus all eighteen omitted fields
  empty.

## Case 5: `record-create/1k-checkbox-fields-bulk-create`

- **Goal**: isolate boolean/null storage semantics in a bulk create.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the two checkbox
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact boolean/null samples plus all eighteen omitted fields
  empty.

## Case 6: `record-create/1k-single-select-fields-bulk-create`

- **Goal**: isolate option lookup and single-select serialization.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the three single-select
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact choice names plus all seventeen omitted fields empty.

## Case 7: `record-create/1k-multiple-select-fields-bulk-create`

- **Goal**: isolate JSON-array validation and multiple-select serialization.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only the two multiple-select
  fields.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact ordered choice arrays plus all eighteen omitted fields
  empty.

## Case 8: `record-create/1k-rating-field-bulk-create`

- **Goal**: isolate bounded rating validation and numeric cell storage.
- **Seed Phase**: the shared deterministic empty 20-field mixed table.
- **Execute Phase**: create 1,000 records carrying only `Score`.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact ratings plus all nineteen omitted fields empty.

## Case 9: `record-create/1k-primary-text-only-bulk-create`

- **Goal**: establish the narrowest one-field table and one-field payload
  baseline for the same 1,000-record endpoint.
- **Seed Phase**: a deterministic empty table containing only `Title`.
- **Execute Phase**: create 1,000 records carrying only `Title`.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact titles on rows 1, 500, and 1,000.

## Case 10: `record-create/1k-wide-table-title-only-bulk-create`

- **Goal**: separate wide-schema planning overhead from payload width by
  creating one-field records in the existing 20-field mixed schema.
- **Seed Phase**: reuse the exact seed config of
  `record-create/mixed-1k-20fields-bulk-create`.
- **Execute Phase**: create 1,000 records carrying only `Title`; omit the other
  nineteen fields from every request record.
- **Primary Metric**: `bulkCreate1kMs`, initial `maxMs: 6_000`.
- **Verification**: exact `Title` plus all nineteen omitted fields empty on rows
  1, 500, and 1,000.

## Explicit Rejections for This Batch

- Do not add scale-only 2k/5k/10k copies. The first 1,000-record request
  boundary already exists; this batch isolates cost dimensions at that fixed
  size.
- Do not include attachment or link fields. Their payload and verification
  contracts are materially different from scalar cells.
- Do not create separate runners per scalar type. One optional payload-field
  selector on the existing lifecycle runner is the intended seam.
- Do not include payload construction, SQL count verification, sample reads,
  or cleanup in `bulkCreate1kMs`; the threshold continues to measure only the
  bulk POST request.
- Do not weaken omitted-field verification. Empty cells may be absent, `null`,
  or the engine's equivalent empty checkbox representation, but they must not
  contain a generated value.
