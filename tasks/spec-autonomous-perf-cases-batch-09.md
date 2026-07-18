# Autonomous Perf Cases — Batch 09

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and replace any field shape that cannot produce deterministic,
cross-engine values.

## Batch Goal

Add a field-type matrix for the grid clipboard paste path. Existing
`record-paste` coverage has three 10,000-row aggregate workloads: a four-field
flat table, a 20-field text table, and a 20-field mixed table. Those cases catch
large-payload regressions, but they cannot identify which scalar typecast path
regressed. The new matrix holds the workload at 1,000 pasted rows and varies
only the table shape.

Reuse the existing `record-paste` runner and its
`record-mutation-lifecycle` seam. The runner already expresses the same user
behavior through the engine-specific product endpoints: V1 calls range paste
and V2 calls paste-by-id. Both paths must create exactly 1,000 rows, assert the
engine route, then read all pasted rows back and compare deterministic values.
The only runner-level extension is adding the `paste1kMs` metric literal to the
typed config; do not fork the runner or change its behavior.

Cases 2-9 use ten-field tables: the required primary `Title` plus nine fields
of one target type (or nine additional text fields for the text case). This
holds table width constant while isolating clipboard parsing, typecasting, and
write behavior. Case 1 is the one-field lower bound. Case 10 is the established
20-field mixed upper comparison.

There is no reusable record seed for this family. Before the primary timer, the
runner creates one empty scratch table with the configured fields and builds a
deterministic tab/newline clipboard payload. The measured window contains only
the paste request. Full-scan value verification and cleanup happen afterward.
This batch therefore adds no seed-row generation to the workflow seed job.

All cases use `paste1kMs` with `maxMs: 6_000`. The initial 15-second assumption
was tightened after the first official V1/V2 run: all 20 artifacts passed at
244.50-2,513.81 ms, so 6 seconds retains about 2.4x headroom over the observed
worst case while detecting a material regression.

## Case 1: `record-paste/1k-primary-only`

- **Goal**: establish the narrowest grid-paste baseline.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates an empty primary-only table.
- **Execute Phase**: paste 1,000 deterministic titles.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: engine route, response shape, 1,000-row full scan, and exact
  values for rows 1, 500, and 1,000.

## Case 2: `record-paste/1k-single-line-text-10fields`

- **Goal**: isolate single-line clipboard parsing and insertion at a fixed
  ten-field width.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine text fields.
- **Execute Phase**: paste a 1,000 × 10 text block.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: full scan of all 10,000 cells and three exact samples.

## Case 3: `record-paste/1k-long-text-10fields`

- **Goal**: isolate long-text payload parsing and writes.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine long-text
  fields.
- **Execute Phase**: paste a 1,000 × 10 text/long-text block.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: every pasted value and all three fixed samples match.

## Case 4: `record-paste/1k-number-10fields`

- **Goal**: isolate clipboard numeric parsing and typecast writes.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine number fields.
- **Execute Phase**: paste 1,000 deterministic numeric rows.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: all parsed numbers match exactly after normalization.

## Case 5: `record-paste/1k-date-10fields`

- **Goal**: isolate date parsing, UTC normalization, and insertion.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine UTC date fields.
- **Execute Phase**: paste 1,000 deterministic calendar-date rows.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: all dates normalize to the expected UTC instant.

## Case 6: `record-paste/1k-checkbox-10fields`

- **Goal**: isolate boolean/blank clipboard typecasting.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine checkbox fields.
- **Execute Phase**: paste alternating checked and blank values.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: all boolean/null states match.

## Case 7: `record-paste/1k-single-select-10fields`

- **Goal**: isolate single-select option resolution during paste.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine single-select
  fields with stable choices.
- **Execute Phase**: paste 1,000 rows cycling through three choice names.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: all resolved choice names match.

## Case 8: `record-paste/1k-multiple-select-10fields`

- **Goal**: isolate comma-delimited multi-select parsing and option resolution.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine multiple-select
  fields with stable choices.
- **Execute Phase**: paste 1,000 rows containing deterministic two-choice cells.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: all ordered choice arrays match after normalization.

## Case 9: `record-paste/1k-rating-10fields`

- **Goal**: isolate bounded rating typecasting during paste.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates `Title` plus nine five-star rating
  fields.
- **Execute Phase**: paste 1,000 rows cycling through ratings 1-5.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: every numeric rating matches.

## Case 10: `record-paste/1k-mixed-20fields`

- **Goal**: provide a bounded mixed-schema comparison to the established 10k
  complex paste workload.
- **Runner**: reuse `record-paste`.
- **Seed Phase**: none; execute setup creates the established 20-field mixed
  scalar schema.
- **Execute Phase**: paste a 1,000 × 20 mixed clipboard block.
- **Primary Metric**: `paste1kMs`, calibrated `maxMs: 6_000`.
- **Verification**: full scan of all 20,000 values and three exact samples.

## Explicit Rejections for This Batch

- Do not add ten 10,000-row cases. Existing CI history shows the 20-field
  workloads take roughly 22 seconds each; multiplying that shape would add
  several minutes per engine without improving type isolation.
- Do not use the selection paste stream. The matrix targets the ordinary grid
  paste action; row/field expansion through stream already has a dedicated 10k
  case.
- Do not seed rows before the operation. These cases specifically measure
  creation by pasting into an empty table.
- Do not count table creation, clipboard payload construction, full-scan
  verification, or cleanup in `paste1kMs`.
- Do not accept response success alone. Every case must assert routing and read
  back all 1,000 records through the real record API.
