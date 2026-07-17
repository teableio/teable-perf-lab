# Autonomous Perf Cases — Batch 03

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and revise or drop any case whose behavior is not deterministic.

## Batch Goal

Cover ten high-value field conversions that rewrite or remove values across an
entire populated column. Batch 02 established the typed-source-to-text matrix;
this batch exercises the opposite coercion direction plus option-pruning
updates:

- text storage to number, select, multi-select, checkbox, date, attachment, and
  auto-number representations;
- number to bounded rating values;
- single-select and multiple-select choice rename/prune semantics.

Every case uses a deterministic two-field, 10,000-row fixture. The primary
metric includes the conversion request, sample readiness, and a complete
10,000-row scan. Verification also requires the requested V1/V2 route, target
field type, and any case-specific option metadata.

## Case 1: `field-convert/10k-text-to-number-mixed`

- **Goal**: guard TEXT-to-REAL conversion with valid and invalid numeric input.
- **Seed Phase**: `Title` plus `Numeric Text`; three of every four rows contain
  deterministic decimal strings and the fourth contains an invalid token.
- **Execute Phase**: convert `Numeric Text` to number.
- **Primary Metric**: `convertTextToNumberReadyMs`, initial `maxMs: 15_000`.
- **Verification**: valid rows become numbers, invalid rows become null, and all
  10,000 rows are scanned.
- **Open Assumptions**: mixed parse success is more diagnostic than an all-valid
  fixture and follows the upstream V1/V2 conversion contract.

## Case 2: `field-convert/10k-text-to-single-select`

- **Goal**: guard creation and backfill of select choices from populated text.
- **Seed Phase**: `Select Text` cycles `Todo`, `Doing`, and `Done`.
- **Execute Phase**: convert to single select with only `Todo` predefined.
- **Primary Metric**: `convertTextToSingleSelectReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: values are retained and the resulting choice-name set is
  exactly `Todo`, `Doing`, and `Done`.
- **Open Assumptions**: deterministic repeated values avoid the pathological
  10,000-choice shape while still exercising option discovery.

## Case 3: `field-convert/10k-text-to-multiple-select`

- **Goal**: guard TEXT-to-JSON conversion and comma-list parsing.
- **Seed Phase**: `Multi Text` cycles four deterministic two-choice comma lists.
- **Execute Phase**: convert to multiple select with two choices predefined.
- **Primary Metric**: `convertTextToMultipleSelectReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: every row becomes the expected ordered array and the four
  choice names are present exactly once.
- **Open Assumptions**: simple comma lists are stable in both engines; quoted
  delimiter edge cases belong in correctness tests, not this perf sentinel.

## Case 4: `field-convert/10k-text-to-checkbox-mixed`

- **Goal**: guard TEXT-to-BOOLEAN coercion with populated and null rows.
- **Seed Phase**: odd rows contain a non-empty text token; even rows are null.
- **Execute Phase**: convert to checkbox.
- **Primary Metric**: `convertTextToCheckboxReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: non-empty values become true and null rows remain unchecked
  (null in storage) across the complete scan.
- **Open Assumptions**: this captures the product truthiness contract without
  inventing a special meaning for the literal string `false`.

## Case 5: `field-convert/10k-text-to-date-mixed`

- **Goal**: guard TEXT-to-DATETIME parsing and invalid-value clearing.
- **Seed Phase**: odd rows contain deterministic UTC ISO datetimes; even rows
  contain invalid date strings.
- **Execute Phase**: convert to a UTC date field with a fixed format.
- **Primary Metric**: `convertTextToDateReadyMs`, initial `maxMs: 15_000`.
- **Verification**: valid rows expose their exact ISO instant and invalid rows
  become null.
- **Open Assumptions**: explicit UTC input and target timezone make this reverse
  direction deterministic; it does not inherit Batch 02's date-to-text display
  ambiguity.

## Case 6: `field-convert/10k-text-to-attachment-clear`

- **Goal**: guard the destructive TEXT-to-JSON attachment conversion path.
- **Seed Phase**: every `Attachment Text` row contains deterministic non-empty
  text that is not an attachment object.
- **Execute Phase**: convert the field to attachment.
- **Primary Metric**: `convertTextToAttachmentReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: the target type is attachment and all 10,000 incompatible
  values are cleared.
- **Open Assumptions**: a full-column clear is a meaningful storage rewrite even
  though no attachment payload can be preserved.

## Case 7: `field-convert/10k-text-to-auto-number`

- **Goal**: guard conversion from mutable text to computed auto-number.
- **Seed Phase**: every `Sequence Text` cell contains deterministic text.
- **Execute Phase**: convert to auto-number and wait for the computed backfill.
- **Primary Metric**: `convertTextToAutoNumberReadyMs`, initial
  `maxMs: 30_000`.
- **Verification**: all values are integers forming the row-ordered sequence
  1 through 10,000.
- **Open Assumptions**: a newly created fixture with no previous auto-number
  field starts this backfill at one; local V1/V2 validation must confirm it.

## Case 8: `field-convert/10k-number-to-rating-clamped`

- **Goal**: guard number-to-rating validation and clamp behavior.
- **Seed Phase**: `Rating Input` cycles integers 1 through 8.
- **Execute Phase**: convert to a five-star rating.
- **Primary Metric**: `convertNumberToRatingReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: 1–5 remain unchanged, 6–8 clamp to 5, and rating max metadata
  is 5.
- **Open Assumptions**: values above the target bound are essential to exercise
  the rewrite rather than a metadata-only conversion.

## Case 9: `field-convert/10k-single-select-choice-prune`

- **Goal**: guard same-type single-select rename and prune across populated rows.
- **Seed Phase**: stable-id choices `Todo`, `Doing`, and `Done` repeat evenly.
- **Execute Phase**: retain the `Todo` id, rename it to `Planned`, and remove the
  other choices.
- **Primary Metric**: `convertSingleSelectChoicesReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: `Todo` rows become `Planned`, removed-choice rows become
  null, and the resulting choice set contains only `Planned`.
- **Open Assumptions**: stable choice ids model the real UI update contract.

## Case 10: `field-convert/10k-multiple-select-choice-prune`

- **Goal**: guard same-type multiple-select filtering and rename over JSON arrays.
- **Seed Phase**: stable-id `Tags` choices generate deterministic two-value arrays.
- **Execute Phase**: retain only `Alpha`, rename it to `Primary`, and remove all
  other choices.
- **Primary Metric**: `convertMultipleSelectChoicesReadyMs`, initial
  `maxMs: 15_000`.
- **Verification**: arrays containing `Alpha` become `["Primary"]`; all other
  arrays become null; the resulting choice set contains only `Primary`.
- **Open Assumptions**: filtering populated arrays is distinct from scalar
  single-select pruning and exercises JSON rewriting.

## Explicit Rejections for This Batch

- Do not add long-text duplicates for number, checkbox, or date: long text and
  single-line text share the relevant physical source representation, so those
  variants add much less signal than the selected target-type matrix.
- Do not add date-to-text: presentation formatting and timezone expectations
  still need their own cross-engine design.
- Do not add attachment payload preservation: arbitrary text is intentionally
  incompatible with attachment objects; attachment mutation performance already
  has dedicated record-update cases.
- Do not add another large link or computed cascade: this batch stays under the
  established narrow-fixture seed budget and contains no expensive scale canary.
