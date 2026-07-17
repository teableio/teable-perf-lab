# Autonomous Perf Cases — Batch 02

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies: proceed with the assumptions below, validate them through local V1/V2
runs, and revise or drop any case that does not produce a stable, meaningful
comparison.

## Batch Goal

Complete two field-lifecycle type matrices that currently stop after a few
representative types:

- restore five populated scalar/select types not covered by the existing long
  text, single-select, and date cases;
- convert five populated source types to single-line text, using conversion
  semantics already asserted by Teable's V2 parity tests but not performance
  guarded in this repository.

All ten fixtures deliberately contain only `Title` plus the field under test.
This keeps the comparison focused and avoids paying the 20-field mixed-table
seed cost ten more times. Every case uses deterministic row-derived values,
measures the operation plus read readiness (never fixture construction), asserts
the canary route, and verifies samples plus a complete 10,000-row scan.

## Case 1: `field-restore/10k-owner-text-field`

- **Goal**: cover restoration of populated single-line text cells.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: 10,000 rows with `Title` and deterministic `Owner Text` only.
- **Execute Phase**: delete `Owner Text` as setup, then measure V1 direct restore
  or the V2 restore stream.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: restored id/name plus all 10,000 text values match the row
  generator; delete/restore routing matches the requested engine.
- **Open Assumptions**: a narrow two-field fixture preserves the operation's
  cell cardinality while removing unrelated seed work.

## Case 2: `field-restore/10k-tags-field`

- **Goal**: cover restoration of array-backed multiple-select cells.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: 10,000 rows cycling deterministic two-choice `Tags` values.
- **Execute Phase**: delete `Tags`, then restore it through the engine-specific
  product path.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: every restored array retains order and values; metadata and
  routes match the contract.
- **Open Assumptions**: multiple-select JSON/array storage is materially
  different from the existing single-select restore case.

## Case 3: `field-restore/10k-amount-field`

- **Goal**: cover restoration of populated number cells.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: 10,000 deterministic decimal `Amount` values.
- **Execute Phase**: delete then restore `Amount`.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: full-scan numeric equality and restored field identity.
- **Open Assumptions**: numeric physical storage warrants an independent
  restore sentinel instead of inferring it from text/select results.

## Case 4: `field-restore/10k-active-field`

- **Goal**: cover restoration of checkbox values, including false/null storage
  normalization.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: 10,000 rows alternating deterministic `Active` values.
- **Execute Phase**: delete then restore `Active`.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: full scan accepts the product's false-as-null representation
  while requiring every true value at the expected row.
- **Open Assumptions**: checkbox nullability is a distinct correctness boundary
  in the V2 batched restore stream.

## Case 5: `field-restore/10k-score-field`

- **Goal**: cover restoration of rating values and rating field metadata.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: 10,000 rows cycling scores 1 through 5.
- **Execute Phase**: delete then restore `Score`.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: all scores plus the restored rating field identity/type are
  readable after completion.
- **Open Assumptions**: rating validation and options make this distinct from a
  plain number column.

## Case 6: `field-convert/10k-single-select-to-text`

- **Goal**: performance-guard single-select to single-line-text conversion.
- **Runner**: `field-convert` (extend its deterministic value model).
- **Seed Phase**: 10,000 `Status` cells cycling `Todo`, `Doing`, and `Done`.
- **Execute Phase**: convert `Status` to single-line text and wait for complete
  readability.
- **Primary Metric**: `convertSingleSelectToTextReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: all option names are preserved as strings and the route is
  `convertField` on the requested engine.
- **Open Assumptions**: this is not duplicated by the existing multiple-select
  case because it avoids array joining and exercises scalar option storage.

## Case 7: `field-convert/10k-number-to-text`

- **Goal**: guard conversion and formatting of 10,000 numeric cells.
- **Runner**: `field-convert` (reuse the Case 6 extension).
- **Seed Phase**: deterministic integer `Amount` values with zero-decimal
  formatting.
- **Execute Phase**: convert `Amount` to single-line text.
- **Primary Metric**: `convertNumberToTextReadyMs`, initial `maxMs: 15_000`.
- **Verification**: the full scan sees the expected decimal strings with no
  numeric coercion left behind.
- **Open Assumptions**: fixed integer formatting avoids locale-dependent output.

## Case 8: `field-convert/10k-checkbox-to-text`

- **Goal**: guard checkbox-to-text conversion across true and unchecked rows.
- **Runner**: `field-convert` (reuse the Case 6 extension).
- **Seed Phase**: alternating checked and unchecked `Active` cells.
- **Execute Phase**: convert `Active` to single-line text.
- **Primary Metric**: `convertCheckboxToTextReadyMs`, initial `maxMs: 15_000`.
- **Verification**: checked rows become `"true"`; unchecked rows remain null;
  every row is scanned.
- **Open Assumptions**: Teable's V1/V2 parity contract intentionally treats an
  unchecked checkbox as null rather than the string `"false"`.

## Case 9: `field-convert/10k-rating-to-text`

- **Goal**: guard conversion of option-bearing rating values to text.
- **Runner**: `field-convert` (reuse the Case 6 extension).
- **Seed Phase**: 10,000 `Score` cells cycling 1 through 5 with stable rating
  options.
- **Execute Phase**: convert `Score` to single-line text.
- **Primary Metric**: `convertRatingToTextReadyMs`, initial `maxMs: 15_000`.
- **Verification**: all rows contain the expected score string after conversion.
- **Open Assumptions**: this complements number conversion because rating has
  bounded-value validation and field options.

## Case 10: `field-convert/10k-long-text-to-text`

- **Goal**: guard conversion of multiline long text to single-line text.
- **Runner**: `field-convert` (reuse the Case 6 extension).
- **Seed Phase**: deterministic three-line `Description` values.
- **Execute Phase**: convert `Description` to single-line text.
- **Primary Metric**: `convertLongTextToTextReadyMs`, initial `maxMs: 15_000`.
- **Verification**: line breaks are normalized to spaces for all 10,000 rows.
- **Open Assumptions**: newline normalization is stable across V1 and V2, as
  specified by the upstream conversion parity tests.

## Explicit Rejections for This Batch

- Do not add another 30k link/table canary: Batch 01 proved that fixture is
  valuable but unusually expensive to seed; this batch keeps every fixture to
  two fields and standard 10k scale.
- Do not add five field-delete type variants: deletion drops the field as one
  operation and does not promise type-specific value recovery, so the marginal
  diagnostic value is much lower than restore or conversion.
- Do not add more lookup/rollup fanout points: that matrix remains dense.
- Do not use date-to-text in this batch: formatted text includes timezone
  presentation details, so it needs a separate cross-engine expectation design
  instead of a guessed string assertion.
