# Scale-up Batch 07: 500 × 100-field form submission

## Selection evidence

The existing scale-up siblings increased sequential form submissions from 50
to 500, but their primary metric is still the latency p95 of one submission.
The latest complete main run (`29815167099`) therefore still reports only
52.94–117.19 ms on V2, and 87.66–100.85 ms where V1 artifacts are available:

| 500-submit case             |                  V1 p95 |    V2 p95 |
| --------------------------- | ----------------------: | --------: |
| single-line text, 10 fields |                90.97 ms |  53.04 ms |
| long text, 10 fields        |                95.43 ms | 117.19 ms |
| number, 10 fields           |                87.66 ms |  60.27 ms |
| date, 10 fields             | not emitted in that run |  56.91 ms |
| checkbox, 10 fields         |                97.17 ms |  56.03 ms |
| single select, 10 fields    | not emitted in that run |  62.04 ms |
| multiple select, 10 fields  |                91.08 ms |  59.26 ms |
| rating, 10 fields           |                96.91 ms |  54.53 ms |

Increasing the sample count again would consume more CI time without changing
what `formSubmitP95Ms` measures. This batch instead scales the per-operation
field width from 10 to 100 while retaining 500 sequential submissions. It does
not assume field-width sensitivity; the resulting history will answer that.

## Shared case spec

- **Goal**: catch form-submit regressions when one request typecasts and writes
  a 100-field record rather than a ten-field record.
- **Runner**: reuse `form-submit`; its existing deterministic generator,
  per-request trace sampling, p95 summary, routing assertions, and full-scan
  verification already support arbitrary scalar field arrays.
- **Seed Phase**: no reusable record seed. Execute setup creates one empty
  100-field table and Form view before the primary metric.
- **Execute Phase**: submit 500 deterministic records sequentially through the
  Form API. Each request carries `Title` plus 99 fields of one scalar type.
- **Primary Metric**: `formSubmitP95Ms`. Use an initial 5,000 ms guardrail so
  the first scale run observes behavior instead of tuning width to a target
  duration.
- **Verification**: full scan all 500 records and explicitly verify rows 1,
  250, and 500 across all 100 fields. Preserve first/middle/last request samples
  and routing evidence.
- **Open Assumptions**: 100 fields is a 10× width step inside the product's
  supported table width. Submission count, request sequence, timer boundary,
  generators, and field type stay fixed. Local results are directional; GitHub
  Actions is the acceptance environment.

## Cases

- `form-submit/sequential-500-single-line-text-100fields`
- `form-submit/sequential-500-long-text-100fields`
- `form-submit/sequential-500-number-100fields`
- `form-submit/sequential-500-date-100fields`
- `form-submit/sequential-500-checkbox-100fields`
- `form-submit/sequential-500-single-select-100fields`
- `form-submit/sequential-500-multiple-select-100fields`
- `form-submit/sequential-500-rating-100fields`

## Acceptance

- All eight cases pass locally on V1 and V2.
- Every artifact reports 500 submissions, 100 fields, matched routing, a
  500-row full scan, and matched deterministic values for the sampled rows.
- GitHub Actions saves each selected request trace without collection failures.
- Compare 10-field and 100-field p95 per engine. Do not infer sensitivity until
  the results are observed.

## Local acceptance

Two initial attempts were discarded because disabling perf-lab trace collection did
not disable Teable's development-default OTLP exporters. With no local collector,
every submission generated an exporter connection error. The framework now clears
the development trace/log exporter defaults when `PERF_LAB_TRACE_ENABLED=false`,
while preserving any explicitly configured exporter. Focused tests cover both paths.

The clean run completed all 16 V1/V2 combinations on `teable-ee/develop` commit
`3834e0111` in 603.48 seconds:

| Field type       | V1 100-field p95 | V1 ratio | V2 100-field p95 | V2 ratio |
| ---------------- | ---------------: | -------: | ---------------: | -------: |
| Single-line text |        100.30 ms |    1.10x |         55.45 ms |    1.05x |
| Long text        |         99.13 ms |    1.04x |         57.75 ms |    0.49x |
| Number           |         97.15 ms |    1.11x |         52.87 ms |    0.88x |
| Date             |         98.29 ms |      n/a |         55.72 ms |    0.98x |
| Checkbox         |         99.95 ms |    1.03x |         52.81 ms |    0.94x |
| Single select    |        131.98 ms |      n/a |         55.73 ms |    0.90x |
| Multiple select  |        111.52 ms |    1.22x |         55.86 ms |    0.94x |
| Rating           |        107.28 ms |    1.11x |         53.60 ms |    0.98x |

The referenced history run did not emit V1 artifacts for date and single select, so
those two V1 ratios remain unreported instead of mixing runs. Every local artifact
passed and reports 500 submissions, 100 fields, a 500-row one-page full scan, three
verified deterministic samples, matched `formSubmit` routing, and zero trace failures
with local trace collection intentionally disabled.

The 10-to-100-field step therefore did not materially increase the V2 p95 and raised
the comparable V1 p95 by only 3% to 22%. That observed result supports a subsequent
step to the product's 500-field limit; it was not assumed before this run.

## CI acceptance

GitHub Actions run `29846330502` completed every workflow job successfully. Its
primary metrics and ratios against the 10-field history run are:

| Field type       | V1 100-field p95 | V1 ratio | V2 100-field p95 | V2 ratio |
| ---------------- | ---------------: | -------: | ---------------: | -------: |
| Single-line text |        156.14 ms |    1.72x |         67.56 ms |    1.27x |
| Long text        |        145.60 ms |    1.53x |         60.01 ms |    0.51x |
| Number           |        142.80 ms |    1.63x |         59.18 ms |    0.98x |
| Date             |        139.83 ms |      n/a |         60.59 ms |    1.06x |
| Checkbox         |        139.38 ms |    1.43x |         57.64 ms |    1.03x |
| Single select    |        157.08 ms |      n/a |         62.28 ms |    1.00x |
| Multiple select  |        168.13 ms |    1.85x |         62.81 ms |    1.06x |
| Rating           |        154.62 ms |    1.60x |         57.52 ms |    1.05x |

All 16 execute artifacts passed. Each reports 500 submissions, 100 fields, a
500-row one-page full scan, three verified samples, matched engine and `formSubmit`
routing, 500 captured trace references, and three selected/saved representative
traces with zero failures or missing fetches. The CI measurements confirm that the
100-field step raises V1 more clearly than the local run but still leaves every
primary metric below 170 ms; V2 remains below 68 ms.
