# Autonomous Perf Cases — Batch 06

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and replace any field-family shape that cannot produce deterministic,
cross-engine values.

## Batch Goal

Turn the existing aggregate
`record-update/mixed-1k-20fields-bulk-update` signal into an independently
diagnosable scalar-field matrix. The existing case proves one 1,000-record,
20-field request, but it cannot identify whether a regression comes from text,
select, number, date, checkbox, rating, payload width, or table-schema width.

The ten new cases all use `PATCH /api/table/{tableId}/record`, update exactly
1,000 existing records in one request, assert V1/V2 `updateRecords` routing,
require 1,000 response record ids, and verify the first, middle, and last rows.
Nine cases use the exact existing 20-field schema so field-family requests are
comparable without schema-shape drift. Cases that omit `Title` must prove it
remains at the seed value; every omitted field must remain unchanged.

The runner may add optional `updateFieldNames` and `seedIdentity` config. The
payload selector must affect only the measured update and updated-state
expectation; it must not enter the seed config. Cases 1-8 and 10, plus the
existing aggregate case, use one explicit `mixed-1k-20fields` seed identity.
That makes the batch build one wide fixture and one narrow fixture instead of
ten nearly identical tables, while retaining the full schema in verification.

## Case 1: `record-update/1k-single-line-text-fields-bulk-update`

- **Goal**: isolate serialization and validation of four single-line text
  fields, including the primary field.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: update all four fields to deterministic `updated-` values.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 1,000 response ids, all four updated values, and the
  other sixteen fields unchanged on rows 1, 500, and 1,000.

## Case 2: `record-update/1k-long-text-fields-bulk-update`

- **Goal**: isolate larger string payloads and long-text cell serialization.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: update only the three long-text fields.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: updated long-text samples plus all seventeen omitted fields
  unchanged.

## Case 3: `record-update/1k-number-fields-bulk-update`

- **Goal**: isolate numeric validation and storage across decimal, integer, and
  percentage-like values.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: update only the three number fields.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact numeric samples plus all seventeen omitted fields
  unchanged.

## Case 4: `record-update/1k-date-fields-bulk-update`

- **Goal**: isolate date parsing, normalization, and database writes.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: move both date fields deterministically by one day.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: normalized date samples plus all eighteen omitted fields
  unchanged.

## Case 5: `record-update/1k-checkbox-fields-bulk-update`

- **Goal**: isolate boolean/null storage semantics in a bulk update.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: update only the two checkbox fields to their second
  deterministic distributions.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact boolean/null samples plus all eighteen omitted fields
  unchanged.

## Case 6: `record-update/1k-single-select-fields-bulk-update`

- **Goal**: isolate option lookup and single-select serialization.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: rotate only the three select values by one choice.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact choice names plus all seventeen omitted fields
  unchanged.

## Case 7: `record-update/1k-multiple-select-fields-bulk-update`

- **Goal**: isolate JSON-array validation and multiple-select serialization.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: rotate only both multiple-select arrays.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact ordered arrays plus all eighteen omitted fields
  unchanged.

## Case 8: `record-update/1k-rating-field-bulk-update`

- **Goal**: isolate bounded rating validation and numeric cell storage.
- **Seed Phase**: the shared deterministic 1,000-row, 20-field mixed fixture.
- **Execute Phase**: rotate only `Score` by one value.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact rating samples plus all nineteen omitted fields
  unchanged.

## Case 9: `record-update/1k-primary-text-only-bulk-update`

- **Goal**: establish the narrowest one-field table and one-field payload
  baseline for the same 1,000-record endpoint.
- **Seed Phase**: a table containing only deterministic `Title` values.
- **Execute Phase**: update only `Title`.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: exact updated titles on the three sample rows.

## Case 10: `record-update/1k-wide-table-title-only-bulk-update`

- **Goal**: separate wide-schema planning overhead from payload width by
  updating one field on the existing 20-field mixed fixture.
- **Seed Phase**: reuse the exact seed config of
  `record-update/mixed-1k-20fields-bulk-update`.
- **Execute Phase**: update only `Title`; omit the other nineteen fields from
  every request record.
- **Primary Metric**: `bulkUpdate1kMs`, initial `maxMs: 8_000`.
- **Verification**: updated `Title` plus all nineteen unchanged seeded controls
  on rows 1, 500, and 1,000.

## Explicit Rejections for This Batch

- Do not add scale-only 2k/5k/10k copies. The endpoint's first 1,000-record
  boundary already exists; this batch isolates cost dimensions at that fixed
  size.
- Do not include attachment or link fields. They already have dedicated runners
  because their setup, payload, and verification contracts are materially
  different from scalar cells.
- Do not create separate runners per scalar type. One optional payload-field
  selector on the existing lifecycle runner is the intended seam.
- Do not put verification or seed restoration inside the primary metric. The
  threshold continues to measure only the bulk PATCH request.
- Do not weaken unchanged-field verification in the partial-payload cases. A
  fast request that accidentally clears omitted cells is a failure.
