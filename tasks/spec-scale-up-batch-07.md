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
