# Perf Case Scale-Up Batch 01

## Selection Contract

- Source: `Performance Track`, using the latest 20 passing runs per case and
  engine.
- Candidate boundary: the slower engine's historical median primary metric is
  below `500ms`; the current query returns 75 cases.
- History stays intact: every experiment is a new case id; existing cases are
  unchanged baselines.
- Each experiment changes one product workload dimension. Timer semantics,
  operation, routing assertions, and verification contract stay unchanged.
- Runtime is an observation, not a target. The first run decides whether the
  selected dimension changes the primary metric enough to merit retaining or
  extending the curve.

## Experiment Log

The first local V1/V2 experiment intentionally tried each selected workload
dimension before deciding whether to retain it:

| Experiment                                              | Scale variable      | V1 primary | V2 primary | Decision                                                                                                                             |
| ------------------------------------------------------- | ------------------- | ---------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `record-read/50k-50fields-filter-number-greater-half`   | rows `10k -> 50k`   |      `0ms` |  not rerun | Reject: filtered scan stayed faster than the baseline scan, so the clamped overhead metric remained zero; V1 setup cost `322,402ms`. |
| `table-restore/30k-20f`                                 | rows `10k -> 30k`   |  `35.46ms` |  `42.58ms` | Reject: record scaling increased setup cost but not the restore request metric.                                                      |
| `duplicate-view/complex-grid-100fields-p95`             | fields `20 -> 100`  |  `54.29ms` |  `41.07ms` | Extend the same variable to the 500-field product boundary before deciding.                                                          |
| `field-create/single-select-10k-options`                | options `1k -> 10k` | `294.21ms` |   HTTP 400 | Reject: V2 enforces the default 1,000-choice safety limit, so the baseline is already at the comparable product boundary.            |
| `form-submit/sequential-50-single-line-text-100fields`  | fields `20 -> 100`  | `142.86ms` |  `98.25ms` | Retain the variable and extend it to 500 fields.                                                                                     |
| `record-duplicate/single-50-single-line-text-100fields` | fields `10 -> 100`  | `256.43ms` | `119.71ms` | Retain the variable and extend it to 500 fields.                                                                                     |
| `duplicate-view/complex-grid-500fields-p95`             | fields `20 -> 500`  |  `75.39ms` |  `54.92ms` | Reject: even at the 500-field product boundary, the primary metric remains in the same tens-of-milliseconds range.                   |
| `form-submit/sequential-50-single-line-text-500fields`  | fields `20 -> 500`  |   PG 54000 |   PG 54000 | Reject: a populated row reaches 9,944 bytes and exceeds PostgreSQL's 8,160-byte row limit.                                           |
| `record-duplicate/single-50-single-line-text-500fields` | fields `10 -> 500`  |   PG 54000 |   PG 54000 | Reject: the deterministic source row reaches 9,056 bytes and exceeds PostgreSQL's 8,160-byte row limit.                              |
| `form-submit/sequential-50-checkbox-500fields`          | fields `20 -> 500`  | `270.92ms` | `127.99ms` | Reject: valid at the compact-value width boundary, but the slower engine still stays below the 500ms review boundary.                |
| `record-duplicate/single-50-checkbox-500fields`         | fields `10 -> 500`  | `258.23ms` | `175.86ms` | Reject: valid at the compact-value width boundary, but the slower engine still stays below the 500ms review boundary.                |
| `duplicate-table/30k-20f`                               | rows `10k -> 30k`   | `554.49ms` | `468.99ms` | Extend the same record-count variable to 50k because V2 remains below the review boundary.                                           |
| `record-paste/5k-primary-only`                          | rows `1k -> 5k`     | `869.77ms` | `298.92ms` | Extend the same paste-row variable to 10k because V2 remains below the review boundary.                                              |
| `field-delete/30k-delete-active-field`                  | rows `10k -> 30k`   | `200.86ms` | `237.82ms` | Reject: the request remained below the review boundary after tripling affected rows; keep the 10k baseline only.                     |

Rejected experiments are not registered cases. Their results are kept here so
later batches do not repeat them or turn an invalid input boundary into a perf
comparison.

## Retained Case Cards

### `record-create/5k-checkbox-fields-bulk-create`

- Baseline: `record-create/1k-checkbox-fields-bulk-create`.
- Single scale variable: records in one request, `1k -> 5k`.
- Runner: reuse `record-create`; keep the same 20-field table and two-checkbox
  partial payload.
- Primary metric: `bulkCreate5kMs`.
- Verification: assert 5,000 response ids, SQL row count, sampled checkbox
  values, and that all omitted fields remain empty.

### `record-update/5k-checkbox-fields-bulk-update`

- Baseline: `record-update/1k-checkbox-fields-bulk-update`.
- Single scale variable: records in one request, `1k -> 5k`.
- Runner: reuse `record-update`; seed in 1,000-row setup batches, then send one
  5,000-record PATCH with the same two-checkbox partial payload.
- Primary metric: `bulkUpdate5kMs`.
- Verification: assert 5,000 response ids and sampled checkbox/omitted-field
  values outside the request timer.

### `duplicate-table/50k-20f`

- Baseline: `duplicate-table/10k-20f`.
- Single scale variable: source records copied by one duplicate request,
  `10k -> 50k`.
- Primary metric: `duplicateTableRequestMs`.
- Verification: wait for 50,000 copied records, then scan all rows and verify
  deterministic samples.

### `table-create/1x-1f-5k-primary-only`

- Baseline: `table-create/1x-1f-1k-primary-only`.
- Single scale variable: inline records in one table-create request,
  `1k -> 5k`.
- Primary metric: `createTable1x5kRecordsMs`.
- Verification: scan all 5,000 rows and verify deterministic samples.

### `record-paste/10k-primary-only`

- Baseline: `record-paste/1k-primary-only`.
- Single scale variable: rows in one primary-only paste request, `1k -> 10k`.
- Primary metric: `paste10kMs`.
- Verification: scan all 10,000 pasted rows and verify deterministic samples.

## Previous Local Observation

The intermediate 200-text-field variants passed, but their primary metrics
remained below the review boundary and they were superseded rather than
retained:

| Case                                                    | V1 primary | V2 primary | Verification                                      |
| ------------------------------------------------------- | ---------: | ---------: | ------------------------------------------------- |
| `form-submit/sequential-50-single-line-text-200fields`  | `209.32ms` | `195.12ms` | 50 records and all 10,000 submitted cells matched |
| `record-duplicate/single-50-single-line-text-200fields` | `140.09ms` | `247.98ms` | 50 duplicates, 200 cells each, final count 150    |

The 500-checkbox-field follow-up also passed after wide-table verification read
all fields without encoding every field id in the URL. Since it still remained
below 500ms, the wide-field experiments are recorded above and removed from the
runnable catalog.

## Local Acceptance

All five retained cases passed fresh local V1/V2 runs. Every primary request is
above 500ms on both local engines, engine routing matched, and deterministic
verification completed outside the request timer where the runner contract
requires it.

| Case                                           |  V1 primary | V2 primary | Verification                                         |
| ---------------------------------------------- | ----------: | ---------: | ---------------------------------------------------- |
| `record-create/5k-checkbox-fields-bulk-create` | `1371.27ms` | `845.15ms` | 5,000 ids, SQL count, and sampled values matched     |
| `record-update/5k-checkbox-fields-bulk-update` |  `954.54ms` | `956.08ms` | 5,000 ids and sampled updated/omitted values matched |
| `duplicate-table/50k-20f`                      | `1121.78ms` | `904.06ms` | all 50,000 copied rows scanned; samples matched      |
| `table-create/1x-1f-5k-primary-only`           |  `889.31ms` | `502.98ms` | all 5,000 inline rows scanned; samples matched       |
| `record-paste/10k-primary-only`                | `1721.60ms` | `664.05ms` | all 10,000 pasted rows scanned; samples matched      |

## Initial Guardrail Assumption

The new cases use deliberately loose `maxMs` values because they have no run
history. These values only fail hung or unexpectedly extreme requests; they do
not encode a desired runtime. Tighten them after CI history exists.
