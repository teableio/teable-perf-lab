# Scale-up Batch 06: 5k × 10-field record paste

## Selection evidence

The latest complete main run (`29815167099`) still measured the V2 primary
metric below the 500 ms review boundary for six 1,000-row scalar paste cases:

| Baseline case                               |          V1 |        V2 |
| ------------------------------------------- | ----------: | --------: |
| `record-paste/1k-single-line-text-10fields` | 1,250.78 ms | 390.65 ms |
| `record-paste/1k-number-10fields`           |   941.53 ms | 398.19 ms |
| `record-paste/1k-checkbox-10fields`         | 1,170.84 ms | 396.72 ms |
| `record-paste/1k-single-select-10fields`    | 1,614.98 ms | 438.44 ms |
| `record-paste/1k-multiple-select-10fields`  | 1,937.28 ms | 424.52 ms |
| `record-paste/1k-rating-10fields`           | 1,808.52 ms | 209.73 ms |

The batch scales the real request-volume variable from 1,000 to 5,000 rows
while holding the ten-field schema and value generators constant. The scale is
chosen independently of a target duration; the run will determine whether each
engine is sensitive to the added rows.

The date, long-text, and mixed baselines are excluded because their latest V2
primary metrics were already above 500 ms. The already-scaled primary-only case
is also excluded.

## Shared case spec

- **Goal**: catch regressions in one grid paste request carrying 5,000 rows and
  50,000 typed cells.
- **Runner**: reuse `record-paste`; its existing config already supports a 5k
  row count and the `paste5kMs` metric.
- **Seed Phase**: no reusable record fixture. Execute setup creates an empty
  table with `Title` plus nine same-type fields and deterministically builds the
  5,000 × 10 TSV payload before measurement.
- **Execute Phase**: issue one paste operation, assert its response and engine
  routing, then stop the primary timer. Full-scan verification and table cleanup
  remain outside the measured operation.
- **Primary Metric**: `paste5kMs`, with a deliberately loose 30,000 ms guardrail
  so the first scale run measures behavior instead of tuning workload to a
  desired duration.
- **Verification**: full scan all 5,000 rows in 1,000-row pages and explicitly
  verify rows 1, 2,500, and 5,000 using the deterministic typed-value model.
- **Open Assumptions**: 5,000 rows is the next natural multiple of the existing
  1,000-row matrix; ten fields and one request remain fixed. The scale direction
  is row/request volume only, not field width. Local results are directional;
  GitHub Actions is the acceptance environment.

## Cases

- `record-paste/5k-single-line-text-10fields`
- `record-paste/5k-number-10fields`
- `record-paste/5k-checkbox-10fields`
- `record-paste/5k-single-select-10fields`
- `record-paste/5k-multiple-select-10fields`
- `record-paste/5k-rating-10fields`

## Acceptance

- All six cases pass locally on V1 and V2.
- Every artifact reports 5,000 verified rows, 10 fields, 50,000 paste cells,
  matched engine routing, and the expected sampled typed values.
- GitHub Actions passes both engines and trace manifests save every selected
  trace without collection failures.
- Report the 1k-to-5k primary-metric ratio per engine; do not infer sensitivity
  before observing those results.
