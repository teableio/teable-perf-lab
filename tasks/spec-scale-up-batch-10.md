# Scale-up Batch 10: 100k numeric record-read queries

## Selection evidence

Run `29815167099` reports `getRecordsQueryOverheadMs=0` for both V1 and V2 on
all three 50k numeric query siblings below:

- `record-read/50k-50fields-filter-number-greater-half`
- `record-read/50k-50fields-filter-number-range-middle-half`
- `record-read/50k-50fields-filter-number-sort-descending`

The zero is not a zero-duration request. Their current primary metric subtracts
a warmed full-table baseline and clamps a negative delta at zero; selective
queries can therefore produce a primary result with no useful latency signal.
Batch 10 scales the real row-count variable from 50k to 100k and makes the
actual queried paged-scan duration primary. Signed overhead and ratio remain in
the artifact as secondary diagnostics.

## Shared fixture

All three cases use one deterministic, runner-owned 100,000-row, 50-field seed:

- 20 stored text fields, three stored numeric fields, five formulas, and 20
  lookups, matching the existing 10k/50k family;
- 1,000-row seed batches and 1,000-row read pages;
- one source table plus one host table, shared by seed hash across query-only
  siblings;
- full computed-readiness and sampled-value verification before timing.

This is the batch's single expensive physical fixture. Query cases reuse it;
they do not create three independent 5-million-cell host seeds.

## Case specs

### `record-read/100k-50fields-filter-number-greater-half`

- Filter `A > 50,000`.
- Expect and verify 50,000 returned records across 50 pages.
- Primary metric: `getRecordsQueryPagedScanMs`.

### `record-read/100k-50fields-filter-number-range-middle-half`

- Filter `A > 25,000 AND A <= 75,000`.
- Expect and verify 50,000 returned records across 50 pages.
- Primary metric: `getRecordsQueryPagedScanMs`.

### `record-read/100k-50fields-filter-number-sort-descending`

- Filter `A > 50,000`, then sort `A` descending.
- Expect and verify 50,000 returned records across 50 pages and sorted order.
- Primary metric: `getRecordsQueryPagedScanMs`.

## Controlled variables

Field layout, generator, permutation, batch/page sizes, predicates, sort order,
timer boundaries, routing assertions, and verification semantics stay fixed.
The data-scale variable is row count (50k to 100k). The primary-metric change
fixes the existing zero-floor observability problem; it does not tune workload
size toward a desired duration.

## Acceptance

- All three cases pass locally and in GitHub Actions on V1 and V2.
- Artifacts report 100,000 seeded rows, 50 projected fields, 50,000 returned
  records, 50 query requests, complete routing matches, and verified samples.
- The shared-seed artifact proves one seed identity is reused across siblings.
- CI saves every selected representative trace with zero failures.
- Compare actual query duration at 100k with the existing artifacts' secondary
  `getRecordsQueryPagedScanMs`; do not compare it to the clamped overhead value.
