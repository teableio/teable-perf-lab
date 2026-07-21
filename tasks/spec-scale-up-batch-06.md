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

## Local validation

Local V1/V2 execution passed all 12 runs in 117.44 seconds against teable-ee
`3834e0111`. Every artifact reports 5,000 prepared and scanned rows, 50,000
paste cells, ten fields, five full-scan pages, matched engine routing, and the
three expected deterministic samples. The local trace backend was unavailable,
so each artifact captured one trace reference but correctly reported the
snapshot as missing; CI remains the trace acceptance surface.

| Case             |       V1 5k | V1 ratio |       V2 5k | V2 ratio |
| ---------------- | ----------: | -------: | ----------: | -------: |
| single-line text | 3,116.65 ms |    2.49× |   965.16 ms |    2.47× |
| number           | 2,328.77 ms |    2.47× |   845.92 ms |    2.13× |
| checkbox         | 3,524.35 ms |    3.01× |   997.52 ms |    2.51× |
| single select    | 3,187.13 ms |    1.97× |   869.19 ms |    1.98× |
| multiple select  | 4,951.74 ms |    2.56× | 1,410.17 ms |    3.32× |
| rating           | 4,613.64 ms |    2.55× |   765.33 ms |    3.65× |

All six workloads are observably row-volume sensitive on both engines. The
5× row increase produced roughly 1.97×–3.65× primary-metric growth locally;
none remains in the sub-500 ms review range.

## CI acceptance

GitHub Actions run
[`29844032258`](https://github.com/teableio/teable-perf-lab/actions/runs/29844032258)
passed seed, V1, V2, and report jobs. All 12 result artifacts passed the
30-second threshold and independently proved 5,000 prepared rows, 50,000 paste
cells, ten fields, five full-scan pages covering 5,000 records, three sampled
rows, and matched engine routing. Each case selected and saved its one request
trace; all 12 manifests report zero failed or missing fetches.

| Case             |       V1 5k | V1 ratio |       V2 5k | V2 ratio |
| ---------------- | ----------: | -------: | ----------: | -------: |
| single-line text | 6,223.65 ms |    4.98× | 1,689.45 ms |    4.32× |
| number           | 4,412.64 ms |    4.69× | 1,644.97 ms |    4.13× |
| checkbox         | 5,580.98 ms |    4.77× | 1,317.56 ms |    3.32× |
| single select    | 5,469.48 ms |    3.39× | 1,441.83 ms |    3.29× |
| multiple select  | 8,464.38 ms |    4.37× | 1,638.81 ms |    3.86× |
| rating           | 7,862.43 ms |    4.35× | 1,018.13 ms |    4.85× |

The official environment confirms all six operations are row-volume sensitive.
The 5× row increase produced 3.29×–4.98× primary-metric growth, and the scaled
V2 cases now measure 1.02–1.69 seconds instead of sub-500 ms.
