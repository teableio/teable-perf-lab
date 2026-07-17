# Autonomous Perf Cases — Batch 05

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and replace any computed-field query shape that is not deterministic or is
not supported by both engines.

## Batch Goal

Extend the independently diagnosable `record-read` query coverage from stored
fields to computed fields. The ten cases reuse the deterministic 10,000-row,
50-projected-field fixture introduced by the existing record-read cases:

- five numeric formulas with different dependency expressions;
- twenty single-value conditional lookups backed by a deterministic
  permutation of 10,000 source rows;
- stored fields `A`, `B`, and `C` for deterministic tie-breaking and grouping.

The shared runner-level seed identity remains unchanged by query-only case
configuration. Seed mode must therefore build the source/host fixture once and
restore it for the other nine cases. Execute mode must restore the same ready
fixture in every V1/V2 leg.

Every case measures actual queried paged-scan duration as its primary metric.
The baseline scan, signed query-minus-baseline delta, and ratio remain
diagnostics; they do not turn a real request into a misleading `0 ms` result.
Every case asserts `getRecords` V1/V2 routing on every page, verifies every
returned projected cell, rejects duplicate/out-of-range rows, checks an exact
deterministic result count, and checks the full group/sort tuple where ordering
is requested.

## Case 1: `record-read/10k-50fields-filter-formula-greater-half`

- **Goal**: isolate a selective numeric predicate on a computed formula.
- **Seed Phase**: reuse the shared fixture; `Formula 1 = A + B + C`.
- **Execute Phase**: baseline scan, then `Formula 1 isGreater 5050`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,004 distinct rows and every formula predicate.
- **Assumption**: both engines expose formula values to the ordinary numeric
  filter compiler used by `getRecords`.

## Case 2: `record-read/10k-50fields-filter-formula-range-middle`

- **Goal**: cover an AND range filter on a computed expression.
- **Seed Phase**: reuse the shared fixture; `Formula 4` is the weighted
  `3*A + 5*B + 7*C` expression.
- **Execute Phase**: baseline scan, then `Formula 4 isGreater 8000` AND
  `Formula 4 isLessEqual 23000`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,000 distinct rows satisfying both predicates.
- **Assumption**: the chosen boundaries give an exact middle-size result while
  avoiding equality ambiguity at the lower edge.

## Case 3: `record-read/10k-50fields-sort-formula-descending`

- **Goal**: isolate sorting a wide result set by a computed numeric value.
- **Seed Phase**: reuse the shared fixture; `Formula 5 = A*B + C`.
- **Execute Phase**: baseline scan, then order by `Formula 5 desc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: all 10,000 rows ordered by the full two-field tuple.
- **Assumption**: stored `A` is a stable tie-breaker for repeated formula values.

## Case 4: `record-read/10k-50fields-filter-sort-formula-selective`

- **Goal**: cover selective formula filtering composed with formula sorting.
- **Seed Phase**: reuse the shared fixture; `Formula 2 = A*C + B`.
- **Execute Phase**: baseline scan, then `Formula 2 isGreater 15000`, ordered by
  `Formula 2 asc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,173 distinct rows satisfying the predicate and
  ordered by the full tuple.
- **Assumption**: this pair models a computed score filter/list sort without
  introducing grouping.

## Case 5: `record-read/10k-50fields-group-stored-sort-formula`

- **Goal**: measure stored-field grouping with computed ordering inside groups.
- **Seed Phase**: reuse the shared fixture where `C` cycles through seven values.
- **Execute Phase**: baseline scan, then group by `C asc` and order by
  `Formula 4 desc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: all 10,000 rows ordered by group plus computed sort tuple.
- **Assumption**: group keys remain stored fields; this batch does not assume
  computed groupBy support.

## Case 6: `record-read/10k-50fields-filter-lookup-not-empty`

- **Goal**: isolate filtering on a computed conditional lookup column.
- **Seed Phase**: reuse the shared fixture; every host row has one
  `Lookup Value 1` result.
- **Execute Phase**: baseline scan, then `Lookup Value 1 isNotEmpty`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 10,000 distinct rows with non-empty lookup arrays.
- **Assumption**: both engines use the public null-expecting operator for a
  lookup's computed result.

## Case 7: `record-read/10k-50fields-search-lookup-visible-row`

- **Goal**: guard field-scoped visible-row search on a computed lookup value.
- **Seed Phase**: reuse the shared fixture; host row 42 resolves source row 3013,
  giving `Read-Value-1-03013`.
- **Execute Phase**: baseline scan, then visible-row search for `1-03013` in
  `Lookup Value 1`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly host row 42, with all 50 projected values correct.
- **Assumption**: search indexes the displayed single-value lookup text and
  `hideNotMatchRow=true` changes the returned row set.

## Case 8: `record-read/10k-50fields-sort-lookup-ascending`

- **Goal**: isolate sorting by a computed lookup text value.
- **Seed Phase**: reuse the shared fixture; the source permutation is bijective,
  so every lookup value is unique.
- **Execute Phase**: baseline scan, then order by `Lookup Value 1 asc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: all 10,000 rows ordered by displayed lookup value.
- **Assumption**: single-item lookup arrays use the same lexical order as their
  displayed text in both engines.

## Case 9: `record-read/10k-50fields-group-stored-sort-lookup`

- **Goal**: cover stored grouping with computed lookup ordering inside groups.
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then group by `C asc`, order by
  `Lookup Value 1 desc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: all 10,000 rows ordered by group and lookup tuple.
- **Assumption**: lookup sorting remains deterministic when combined with
  low-cardinality stored grouping.

## Case 10: `record-read/10k-50fields-filter-group-sort-formula`

- **Goal**: guard the full selective computed-filter, stored-group, and
  computed-sort path.
- **Seed Phase**: reuse the shared fixture.
- **Execute Phase**: baseline scan, then `Formula 2 isGreater 15000`, group by
  `C asc`, and order by `Formula 2 desc`, `A asc`.
- **Primary Metric**: `getRecordsQueryPagedScanMs`, initial `maxMs: 8_000`.
- **Verification**: exactly 5,173 distinct rows satisfying the formula filter
  and ordered by the full group/sort tuple.
- **Assumption**: this composition materially differs from Case 4 because it
  exercises grouped paging and group boundaries.

## Explicit Rejections for This Batch

- Do not add 50k scale copies. This batch isolates computed query semantics and
  reuses the already calibrated 10k fixture.
- Do not group directly by a computed field. The current cross-engine contract
  is intentionally limited to stored group keys until computed groupBy is
  proven independently.
- Do not include seed/restore time in the primary metric. Seed diagnostics and
  cache-hit state remain separate artifact evidence.
- Do not add another stored-only filter/sort/group case; Batch 04 already owns
  those shapes.
- If lookup search or lookup ordering differs semantically between V1 and V2,
  replace that case with another deterministic computed-query shape rather than
  weakening exact verification.
