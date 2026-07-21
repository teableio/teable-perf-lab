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

Trace selection is limited to duplicate requests 1, 250, and 500, with any
duplicate request available as fallback. The first CI attempt selected all 500
requests per case; V2 saved 482–500 traces and reported up to 18 missing fetches,
so that green job is not accepted. Representative selection keeps the evidence
boundary deterministic without turning the case into an exporter-retention test.

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

## CI attempt 1

Run `29847510570` completed successfully and all 16 functional artifacts passed:

| Field type       |    V1 p95 |    V2 p95 |
| ---------------- | --------: | --------: |
| Single-line text | 182.61 ms | 113.59 ms |
| Long text        | 163.97 ms |  99.65 ms |
| Number           | 158.61 ms |  98.27 ms |
| Date             | 155.48 ms | 129.91 ms |
| Checkbox         | 151.99 ms |  89.42 ms |
| Single select    | 173.48 ms |  99.72 ms |
| Multiple select  | 161.69 ms | 110.00 ms |
| Rating           | 150.13 ms | 122.41 ms |

Every artifact reports 100 fields, 1,000 source rows, 500 duplicate requests,
500 checked duplicates, a final count of 1,500, three samples, and 500 matched
route checks. However, the default trace selector chose all 500 requests per case.
V1 saved 484–500 and V2 saved 482–500, with `missingFetchCount` up to 18. The
functional measurements remain useful, but this run is not final acceptance; the
representative trace selector above must pass in a corrected CI run.

## CI attempt 2

Run `29849361390` completed successfully with the representative selector and all
16 functional artifacts passed:

| Field type       |    V1 p95 |    V2 p95 |
| ---------------- | --------: | --------: |
| Single-line text | 144.56 ms | 103.20 ms |
| Long text        | 130.39 ms |  89.37 ms |
| Number           | 421.52 ms |  86.48 ms |
| Date             | 127.55 ms |  96.29 ms |
| Checkbox         | 121.58 ms |  83.45 ms |
| Single select    | 148.51 ms |  91.13 ms |
| Multiple select  | 427.15 ms |  94.56 ms |
| Rating           | 132.44 ms | 100.77 ms |

Every artifact again reports 100 fields, 1,000 source rows, 500 duplicate
requests, 500 checked duplicates, a final count of 1,500, three verified samples,
and 500 matched route checks. The selector chose exactly three traces in every
case. Fourteen of the sixteen manifests saved all three; the V1 number and V2
single-line-text manifests each missed one Jaeger fetch without a case failure.
Targeted runs `29850578035` and `29850475241` retain the same workload and engines
to complete those two trace-evidence gaps without changing the measurement. Both
targeted artifacts passed with 500 trace references, exactly three selected and
saved traces, zero failures, and zero missing fetches. Together with the full-matrix
functional evidence, these runs satisfy final CI acceptance.
