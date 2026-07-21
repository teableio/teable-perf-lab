# Scale-up Batch 08: 500 sequential record duplicates at 100 fields

## Selection evidence

The latest complete main run (`29815167099`) shows that the existing 500-operation
siblings still have short per-request primary metrics:

| 500-duplicate case          |                  V1 p95 |    V2 p95 |
| --------------------------- | ----------------------: | --------: |
| single-line text, 10 fields |                94.66 ms |  73.53 ms |
| long text, 10 fields        |                99.48 ms |  72.37 ms |
| number, 10 fields           |                96.43 ms |  70.86 ms |
| date, 10 fields             |                99.61 ms | 153.62 ms |
| checkbox, 10 fields         |                90.65 ms |  72.45 ms |
| single select, 10 fields    | not emitted in that run |  70.12 ms |
| multiple select, 10 fields  |               102.87 ms |  70.27 ms |
| rating, 10 fields           |               109.23 ms |  76.49 ms |

`duplicateSingleP95Ms` measures one duplicate request, so increasing the sequential
request count again would mainly extend total CI duration. This batch instead scales
the duplicated record width from 10 to 100 fields while retaining 500 operations. It
does not assume field-width sensitivity; local and CI measurements decide that.

## Shared case spec

- **Goal**: catch duplicate-record regressions when one request copies a 100-field
  scalar record rather than a ten-field record.
- **Runner**: reuse `record-duplicate-single`; its deterministic source generator,
  per-request latency summary, routing assertions, and duplicate-value verification
  already operate from the configured field array.
- **Seed Phase**: create 1,000 deterministic source rows in a 100-field table and
  verify source readiness before timing.
- **Execute Phase**: sequentially duplicate the first 500 source rows through the
  public single-record duplicate endpoint.
- **Primary Metric**: `duplicateSingleP95Ms`. Retain a 5,000 ms failure ceiling for
  the initial width experiment; it is not a runtime target.
- **Verification**: verify every duplicated row and final row count, including
  deterministic samples at offsets 0, 249, and 499, with matched V1/V2 routing.
- **Controlled variables**: request count, source row count, generator, timer
  boundary, field type, and request order stay fixed. Only field width changes from
  10 to 100.

## Cases

- `record-duplicate/single-500-single-line-text-100fields`
- `record-duplicate/single-500-long-text-100fields`
- `record-duplicate/single-500-number-100fields`
- `record-duplicate/single-500-date-100fields`
- `record-duplicate/single-500-checkbox-100fields`
- `record-duplicate/single-500-single-select-100fields`
- `record-duplicate/single-500-multiple-select-100fields`
- `record-duplicate/single-500-rating-100fields`

## Acceptance

- All eight cases pass locally on V1 and V2.
- Every artifact reports 1,000 source rows, 500 duplicate requests, 100 fields,
  matched routing, and correct duplicated values.
- GitHub Actions saves every selected request trace with zero failures.
- Compare 10-field and 100-field p95 per engine without tuning width to a target
  duration.

## Local acceptance

The run completed all 16 V1/V2 combinations on `teable-ee/develop` commit
`3834e0111` in 775.23 seconds:

| Field type       | V1 100-field p95 | V1 ratio | V2 100-field p95 | V2 ratio |
| ---------------- | ---------------: | -------: | ---------------: | -------: |
| Single-line text |        108.44 ms |    1.15x |         77.75 ms |    1.06x |
| Long text        |        108.25 ms |    1.09x |         78.81 ms |    1.09x |
| Number           |        105.93 ms |    1.10x |         77.08 ms |    1.09x |
| Date             |        108.01 ms |    1.08x |         80.90 ms |    0.53x |
| Checkbox         |        104.44 ms |    1.15x |         88.44 ms |    1.22x |
| Single select    |        116.96 ms |      n/a |         81.85 ms |    1.17x |
| Multiple select  |        121.46 ms |    1.18x |         81.16 ms |    1.15x |
| Rating           |        110.78 ms |    1.01x |         78.69 ms |    1.03x |

The referenced history run did not emit the 10-field single-select V1 artifact, so
that ratio is intentionally unreported. Every result passed and reports 1,000 ready
source rows, 100 fields, 500 duplicate requests and routing checks, 500 fully checked
duplicates, a final count of 1,500, three deterministic samples, and zero trace
failures with local trace collection disabled.

The controlled 10-to-100-field step increased the comparable p95 values by only
1% to 22%, except for the faster date V2 sample. The primary metric therefore remains
well below 500 ms across the matrix. This observed result justifies testing a single
500-field maximum-width canary before expanding that much more expensive fixture to
all scalar types.
