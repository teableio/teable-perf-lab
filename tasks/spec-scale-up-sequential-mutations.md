# Scale-Up Spec: Sequential Mutations

## Scope

Add independent scale-up siblings for the 11 fast `record-duplicate-single`
baselines and the 11 fast `form-submit` baselines in the frozen campaign.

## Scale Dimension

- Record duplicate field-matrix cases: 50 sequential duplicate requests -> 500.
- Record duplicate mixed case: 100 sequential duplicate requests -> 1,000.
- Form field-matrix cases: 50 sequential submissions -> 500.
- Mixed form case: 200 sequential submissions -> 1,000.

The request payload and endpoint stay unchanged. The existing per-request p95
remains the primary threshold metric; the runner's total-loop metric and the
artifact request count prove the larger aggregate workload.

## Fixture Reuse

- Duplicate cases reuse one deterministic source fixture per compatible field
  schema. The 500-request mixed case and 1,000-request mixed case both use the
  same 1,000-row mixed fixture shape.
- Form cases build a fresh Form-view table in execute, so there is no seeded
  table to share.

## Verification

- Preserve V1/V2 routing assertions and timer boundaries.
- Verify every created record through the existing full-scan contract and
  sample the first, middle, and last created rows.
- Run `pnpm check`, then local V1/V2 execute for all 21 siblings and inspect
  artifacts for result, routing, request count, final count, primary metric,
  total-loop metric, and trace manifest counts.

## Local Acceptance

All 22 siblings passed local V1/V2 execution. Every artifact has matched routing,
the promised request count, and the complete final row count. The table reports
both the existing per-request p95 primary metric and the full sequential loop
phase; the latter is the scale signal these siblings add. Trace references were
captured, but local snapshot downloads failed because no Jaeger URL was configured.

| Case                                                    |    V1 p95 | V1 loop |   V2 p95 | V2 loop |
| ------------------------------------------------------- | --------: | ------: | -------: | ------: |
| `form-submit/sequential-1000`                           |  79.95 ms | 70.33 s | 55.14 ms | 40.85 s |
| `form-submit/sequential-500-checkbox-10fields`          |  74.21 ms | 32.34 s | 45.69 ms | 17.95 s |
| `form-submit/sequential-500-date-10fields`              |  81.29 ms | 33.96 s | 45.30 ms | 17.45 s |
| `form-submit/sequential-500-long-text-10fields`         |  82.19 ms | 34.64 s | 50.88 ms | 19.55 s |
| `form-submit/sequential-500-multiple-select-10fields`   |  71.12 ms | 32.76 s | 41.10 ms | 17.48 s |
| `form-submit/sequential-500-number-10fields`            |  96.56 ms | 36.17 s | 42.00 ms | 17.29 s |
| `form-submit/sequential-500-primary-only`               |  69.39 ms | 31.30 s | 60.56 ms | 20.07 s |
| `form-submit/sequential-500-rating-10fields`            |  94.34 ms | 36.08 s | 40.50 ms | 17.15 s |
| `form-submit/sequential-500-single-line-text-10fields`  |  89.62 ms | 34.57 s | 61.47 ms | 21.78 s |
| `form-submit/sequential-500-single-line-text-20fields`  | 115.83 ms | 38.66 s | 65.73 ms | 20.27 s |
| `form-submit/sequential-500-single-select-10fields`     |  76.87 ms | 33.56 s | 72.88 ms | 21.39 s |
| `record-duplicate/single-500-checkbox-10fields`         | 107.17 ms | 37.44 s | 54.22 ms | 22.77 s |
| `record-duplicate/single-500-date-10fields`             | 116.01 ms | 40.24 s | 53.14 ms | 22.95 s |
| `record-duplicate/single-500-long-text-10fields`        |  99.95 ms | 37.85 s | 57.67 ms | 23.38 s |
| `record-duplicate/single-500-mixed-20fields`            |  99.50 ms | 39.54 s | 67.89 ms | 26.23 s |
| `record-duplicate/single-500-multiple-select-10fields`  |  76.63 ms | 35.32 s | 74.07 ms | 26.61 s |
| `record-duplicate/single-500-number-10fields`           |  95.91 ms | 39.37 s | 85.80 ms | 26.25 s |
| `record-duplicate/single-500-primary-only`              | 116.37 ms | 40.57 s | 59.01 ms | 22.44 s |
| `record-duplicate/single-500-rating-10fields`           |  82.96 ms | 35.77 s | 62.29 ms | 24.14 s |
| `record-duplicate/single-500-single-line-text-10fields` |  95.38 ms | 38.09 s | 90.32 ms | 27.63 s |
| `record-duplicate/single-500-single-select-10fields`    |  88.07 ms | 36.35 s | 61.95 ms | 24.20 s |
| `record-duplicate/single-record-sequential-1000`        | 129.80 ms | 89.55 s | 64.77 ms | 50.86 s |
