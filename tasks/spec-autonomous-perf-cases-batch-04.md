# Autonomous Perf Cases — Batch 04

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and revise or drop any query shape that is not deterministic.

## Batch Goal

Split the current all-in-one record-read query sentinel into ten independently
diagnosable product query shapes. All cases reuse the existing deterministic
10,000-row, 50-projected-field fixture and compare a queried paged scan with an
unqueried paged scan on the same warmed table.

The runner extension must keep query-only configuration outside the seed hash.
With seed caching enabled, the batch therefore builds one source/host fixture
and restores it for the remaining cases instead of repeating the expensive
10k-row computed fixture ten times.

Every case measures non-negative query overhead (`queryMs - baselineMs`, clamped
at zero), preserves the signed delta and ratio for diagnosis, asserts V1/V2
routing on every page, verifies every returned projected cell, rejects duplicate
or out-of-range rows, and checks an exact expected returned-row count derived
from the deterministic query.

## Case 1: `record-read/10k-50fields-filter-text-not-empty`

- **Goal**: isolate the cost of applying a match-all text filter to a wide read.
- **Runner**: `record-read` (extend its query model from three fixed clauses to
  optional structured clauses).
- **Seed Phase**: reuse the 10k/50-field record-read fixture.
- **Execute Phase**: baseline scan, then scan with `Text 1 isNotEmpty`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows and all 50 projected values.
- **Open Assumptions**: a match-all predicate isolates filter planning and
  evaluation without mixing in selectivity.

## Case 2: `record-read/10k-50fields-filter-number-greater-half`

- **Goal**: cover a selective numeric predicate over a wide table.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture where `A` is row number 1–10,000.
- **Execute Phase**: baseline scan, then scan with `A isGreater 5000`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,000 distinct rows, all with `A > 5000`.
- **Open Assumptions**: 50% selectivity is large enough to retain paging cost
  while proving that the query actually filters rows.

## Case 3: `record-read/10k-50fields-filter-number-range-middle-half`

- **Goal**: cover an AND filter with two predicates on the same numeric field.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then scan with `A isGreater 2500` AND
  `A isLessEqual 7500`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,000 distinct rows in the inclusive upper range.
- **Open Assumptions**: same-field range predicates are a common grid filter and
  exercise conjunction compilation separately from a single predicate.

## Case 4: `record-read/10k-50fields-search-title-visible-rows`

- **Goal**: guard visible-row search on one stored text field.
- **Runner**: `record-read` (extend its query model with the public `search`
  tuple).
- **Seed Phase**: reuse the shared fixture with deterministic padded titles.
- **Execute Phase**: baseline scan, then scan with visible-row search for
  `00042` in `Title`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly one row, title `Read row-00042`, with all 50 values.
- **Open Assumptions**: field-scoped search with `hideNotMatchRow=true` models
  grid search that changes the visible record set; highlight-only search would
  not provide a meaningful read-result assertion.

## Case 5: `record-read/10k-50fields-sort-text-ascending`

- **Goal**: isolate sorting a wide result set by a stored text column.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then scan with `Text 1 asc`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows and nondecreasing `Text 1`.
- **Open Assumptions**: padded deterministic values make lexical order stable
  across engines.

## Case 6: `record-read/10k-50fields-sort-three-fields`

- **Goal**: cover multi-column sort planning and paging.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture where `C` cycles 1–7, `B` cycles
  1–100, and `A` is unique.
- **Execute Phase**: baseline scan, then scan with `C asc`, `B desc`, `A asc`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows and lexicographically ordered
  sort tuples; unique `A` is the deterministic tiebreaker.
- **Open Assumptions**: three columns represent a realistic upper-bound grid
  sort without turning the case into a scale-only duplicate.

## Case 7: `record-read/10k-50fields-group-number-low-cardinality`

- **Goal**: isolate grouping by a low-cardinality stored number field.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture where `C` has seven values.
- **Execute Phase**: baseline scan, then scan with `C asc` groupBy.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows and nondecreasing group keys.
- **Open Assumptions**: seven groups approximate a status/category grouping and
  differ materially from the existing unique-text group.

## Case 8: `record-read/10k-50fields-group-three-levels`

- **Goal**: cover nested grouping across low-, medium-, and high-cardinality
  fields.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then scan with groupBy `C asc`, `B desc`,
  `A asc`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows and ordered group tuples.
- **Open Assumptions**: the unique final level gives deterministic paging while
  still exercising the multi-level group path.

## Case 9: `record-read/10k-50fields-filter-number-sort-descending`

- **Goal**: cover a selective filter composed with an explicit sort.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then `A isGreater 5000` with `A desc`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,000 distinct rows ordered from `A=10000` to
  `A=5001`.
- **Open Assumptions**: this pair isolates the common filtered-list query path;
  the existing all-clause case cannot attribute a regression to this pair.

## Case 10: `record-read/10k-50fields-filter-sort-groupby-selective`

- **Goal**: guard the full composed query path with a genuinely selective
  predicate and low-cardinality grouping.
- **Runner**: `record-read` (reuse the Batch 04 extension).
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then `A isGreater 5000`, groupBy `C asc`,
  and orderBy `A desc`.
- **Primary Metric**: `getRecordsQueryOverheadMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,000 distinct rows, every row satisfies the filter,
  and the returned order obeys the query's group/sort tuple.
- **Open Assumptions**: this is not a duplicate of the existing match-all
  filter + unique-text group case because both selectivity and group cardinality
  change the database plan.

## Explicit Rejections for This Batch

- Do not add 50k variants: this batch is about query shape and diagnosis, not
  scale. One shared 10k fixture controls seed cost.
- Do not count seed/restore time in the primary metric. Seed diagnostics remain
  visible separately, and a cache miss must not look like a query regression.
- Do not use highlight-only search: it returns the baseline row set and cannot
  prove that search semantics were applied.
- Do not query computed fields in this batch. The shared projection still reads
  formulas and lookups, but stored-field filter/sort/group semantics provide a
  stable V1/V2 comparison before adding computed-query variants later.
- Do not add another all-clause match-all case. The catalog already has
  `record-read/10k-50fields-filter-sort-groupby-overhead` for that exact shape.
