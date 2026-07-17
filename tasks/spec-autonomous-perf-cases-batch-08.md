# Autonomous Perf Cases — Batch 08

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and replace any field shape that cannot produce deterministic,
cross-engine values.

## Batch Goal

Turn the single aggregate
`record-duplicate/single-record-sequential-100` signal into a table-shape
matrix for the same `POST /api/table/{tableId}/record/{recordId}/duplicate`
endpoint. The existing 20-field case proves per-request p95 latency over 100
sequential duplicates, but it cannot identify whether a regression comes from
table width or a particular scalar field family.

Each new case seeds exactly 100 deterministic source records, duplicates the
first 50 records sequentially, and records `duplicateSingleP95Ms` as the
primary metric. Fifty requests provide a useful p95 distribution while keeping
the batch bounded at 500 requests per engine. The runner must continue to
assert every response, every request's V1/V2 `duplicateRecord` routing, every
duplicated cell, the 50 returned ids, and the final table count of 150.

Cases 2-9 use ten-field tables: the required primary `Title` plus nine fields
of one target type (or nine additional text fields for the text case). This
holds table width constant while isolating serialization and copy behavior.
Case 1 is the one-field lower bound. Case 10 is the established 20-field mixed
upper comparison. All source fixtures are independent because their schemas
are intentionally different; each remains hash-cached across workflow runs.

The case files should use one shared factory for the fixed 100-row / 50-request
lifecycle and shared deterministic field builders. Do not add a new runner or
fork the duplicate lifecycle.

## Case 1: `record-duplicate/single-50-primary-only`

- **Goal**: establish the narrowest possible duplicate-record baseline.
- **Seed Phase**: 100 records in a table containing only primary `Title`.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: 50 created ids; exact titles for all duplicated records;
  sampled rows 1, 25, and 50; final count 150.

## Case 2: `record-duplicate/single-50-single-line-text-10fields`

- **Goal**: isolate single-line text copy and response serialization at a
  fixed ten-field width.
- **Seed Phase**: `Title` plus nine deterministic single-line text fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all ten text cells match each source record.

## Case 3: `record-duplicate/single-50-long-text-10fields`

- **Goal**: isolate larger string copy and long-text serialization.
- **Seed Phase**: `Title` plus nine deterministic long-text fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all ten cells match, including every long-text payload.

## Case 4: `record-duplicate/single-50-number-10fields`

- **Goal**: isolate numeric value cloning and response conversion.
- **Seed Phase**: `Title` plus nine number fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all numeric values match the deterministic source rows.

## Case 5: `record-duplicate/single-50-date-10fields`

- **Goal**: isolate date copy and normalization cost.
- **Seed Phase**: `Title` plus nine UTC date fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all dates match after normalizing to the calendar date.

## Case 6: `record-duplicate/single-50-checkbox-10fields`

- **Goal**: isolate boolean/null copy behavior.
- **Seed Phase**: `Title` plus nine checkbox fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all checked and empty checkbox states match.

## Case 7: `record-duplicate/single-50-single-select-10fields`

- **Goal**: isolate single-select option cloning.
- **Seed Phase**: `Title` plus nine single-select fields sharing three stable
  choice names.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: every duplicated choice name matches its source.

## Case 8: `record-duplicate/single-50-multiple-select-10fields`

- **Goal**: isolate multi-value select array cloning.
- **Seed Phase**: `Title` plus nine multiple-select fields sharing four stable
  choice names.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: every duplicated ordered choice array matches its source.

## Case 9: `record-duplicate/single-50-rating-10fields`

- **Goal**: isolate bounded rating cell cloning at the same ten-field width.
- **Seed Phase**: `Title` plus nine five-star rating fields.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: every duplicated rating value matches its source.

## Case 10: `record-duplicate/single-50-mixed-20fields`

- **Goal**: retain a smaller-request-count comparison against the established
  20-field mixed schema.
- **Seed Phase**: 100 deterministic records with the existing text, select,
  number, date, checkbox, and rating mix.
- **Execute Phase**: duplicate source rows 1-50 sequentially.
- **Primary Metric**: `duplicateSingleP95Ms`, initial `maxMs: 2_000`.
- **Verification**: all twenty duplicated cells match their source rows.

## Explicit Rejections for This Batch

- Do not build a selection-stream projection matrix. Source inspection shows
  the legacy V1 path applies `projection` while the V2 stream command currently
  ignores it; those cases would compare different workloads across engines.
- Do not add ten more 1,000-row stream cases. The current V1 baseline is about
  84 seconds for one such case, so that matrix would consume excessive CI time.
- Do not use different request counts by field family. Every p95 distribution
  must contain the same 50 sequential requests.
- Do not include source lookup, response-value assertions, post-run duplicate
  scans, final-count verification, or cleanup in the primary metric.
- Do not weaken full-value verification to samples only. The runner already
  checks all 50 duplicated records; retain that contract.
