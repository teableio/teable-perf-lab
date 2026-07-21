# Scale-Up Campaign

## Goal

Create one independent scale-up sibling for every baseline whose latest-20 passing-run V1 and V2 primary-metric medians are both below 500ms. Preserve baseline ids and history. Reuse the largest deterministic seed inside each compatible fixture family; do not share one physical table across incompatible schemas or dependency graphs.

## Frozen Scope

- Source: production `Performance Track` table `tblwPqrcchUzvyEOqLo`.
- Snapshot: latest 20 passing runs per case and engine, queried 2026-07-21.
- Baselines: 75.
- A scale-up remains useful even when its primary metric stays below 500ms; the campaign records the observed high-scale boundary instead of deleting a valid case.
- Exceptions require evidence of a product hard limit or an unstable V1/V2 execution boundary.

## Seed Families

- `mixed-50k-20f`: field lifecycle, record mutations, delete/replay, and related stored-field workloads.
- `read-50k-50f`: record-read query variants on the shared widest read fixture.
- `search-100k-20f`: search-index variants that already exhausted the 50k row curve.
- `computed-chain-20k` / `customer-chain-20k`: lookup/formula/rollup dependency graph workloads.
- `empty-mixed-20f`, `empty-form`, `empty-primary`: create/paste/form workloads where inserted data belongs in execute rather than seed.
- `table-lifecycle-50k`, `duplicate-50k-20f`, `wide-grid-500f`: destructive or schema-level operations; use isolated execute databases or lifecycle restore.

## Acceptance Per Sibling

1. Same product operation, routing assertion, timer boundary, and verification contract as the baseline.
2. Change one workload scale dimension; derived fixture size may change with that dimension.
3. `pnpm check` passes.
4. Local V1 and V2 artifacts pass, route correctly, and prove the full promised final state.
5. Record primary metrics and trace manifest counts. CI remains the official acceptance surface.

## Tracker

| Baseline                                                            | V1 median ms | V2 median ms | Proposed scale-up                                                    | Seed family              | Status     |
| ------------------------------------------------------------------- | -----------: | -----------: | -------------------------------------------------------------------- | ------------------------ | ---------- |
| `duplicate-table/10k-20f-selflink`                                  |       497.79 |       337.13 | `duplicate-table/10k-20f-selflink-2k-links`                          | `duplicate-selflink-10k` | local-pass |
| `record-create/1k-multiple-select-fields-bulk-create`               |       496.92 |       435.14 | `record-create/5k-multiple-select-fields-bulk-create`                | `empty-mixed-20f`        | local-pass |
| `duplicate-table/10k-20f`                                           |       490.43 |       318.13 | `duplicate-table/50k-20f`                                            | `duplicate-50k-20f`      | local-pass |
| `field-delete/10k-delete-start-date-field`                          |       192.09 |       471.75 | `field-delete/50k-delete-start-date-field`                           | `mixed-50k-20f`          | local-pass |
| `field-delete/10k-delete-description-field`                         |       177.36 |       464.04 | `field-delete/50k-delete-description-field`                          | `mixed-50k-20f`          | local-pass |
| `field-delete/10k-delete-status-field`                              |       168.23 |       460.24 | `field-delete/50k-delete-status-field`                               | `mixed-50k-20f`          | local-pass |
| `lookup/customer-update-user-control-field-create-order-4k-depth5`  |       459.13 |       307.17 | `lookup/customer-update-user-control-field-create-order-20k-depth5`  | `customer-chain-20k`     | local-pass |
| `field-delete/10k-delete-owner-text-field`                          |       168.33 |       451.92 | `field-delete/50k-delete-owner-text-field`                           | `mixed-50k-20f`          | local-pass |
| `field-delete/10k-delete-active-field`                              |       155.51 |       451.16 | `field-delete/50k-delete-active-field`                               | `mixed-50k-20f`          | local-pass |
| `field-delete/10k-delete-tags-field`                                |       184.26 |       438.89 | `field-delete/50k-delete-tags-field`                                 | `mixed-50k-20f`          | local-pass |
| `field-delete/10k-delete-amount-field`                              |       173.52 |       437.76 | `field-delete/50k-delete-amount-field`                               | `mixed-50k-20f`          | local-pass |
| `lookup/foreign-select-flip-1of40-fanout100-4k`                     |       311.34 |       437.51 | `lookup/foreign-select-flip-1of40-fanout500-20k`                     | `computed-chain-20k`     | local-pass |
| `field-delete/10k-delete-score-field`                               |       167.71 |       428.67 | `field-delete/50k-delete-score-field`                                | `mixed-50k-20f`          | local-pass |
| `record-create/1k-number-fields-bulk-create`                        |       383.65 |       421.47 | `record-create/5k-number-fields-bulk-create`                         | `empty-mixed-20f`        | local-pass |
| `record-create/1k-rating-field-bulk-create`                         |       368.59 |       408.13 | `record-create/5k-rating-field-bulk-create`                          | `empty-mixed-20f`        | local-pass |
| `record-update/1k-number-fields-bulk-update`                        |       347.42 |       405.28 | `record-update/5k-number-fields-bulk-update`                         | `mixed-5k-20f`           | local-pass |
| `record-delete/link-trash-1k`                                       |       397.57 |       329.38 | `record-delete/link-trash-5k`                                        | `linked-5k-20f`          | local-pass |
| `table-create/1x-1f-1k-primary-only`                                |       395.25 |       282.78 | `table-create/1x-1f-5k-primary-only`                                 | `inline-create`          | local-pass |
| `lookup/foreign-first-name-update-1of40-fanout100-4k`               |       305.39 |       391.18 | `lookup/foreign-first-name-update-1of40-fanout500-20k`               | `computed-chain-20k`     | local-pass |
| `record-update/1k-checkbox-fields-bulk-update`                      |       382.70 |       389.69 | `record-update/5k-checkbox-fields-bulk-update`                       | `mixed-5k-20f`           | local-pass |
| `lookup/customer-create-order-only-4k-depth5`                       |       381.33 |       236.13 | `lookup/customer-create-order-only-20k-depth5`                       | `customer-chain-20k`     | local-pass |
| `record-paste/1k-primary-only`                                      |       367.53 |       186.14 | `record-paste/10k-primary-only`                                      | `empty-primary`          | local-pass |
| `record-create/1k-checkbox-fields-bulk-create`                      |       358.33 |       348.72 | `record-create/5k-checkbox-fields-bulk-create`                       | `empty-mixed-20f`        | local-pass |
| `record-create/1k-wide-table-title-only-bulk-create`                |       330.09 |       357.42 | `record-create/5k-wide-table-title-only-bulk-create`                 | `empty-mixed-20f`        | local-pass |
| `record-delete/delete-stream-1k`                                    |       237.66 |       348.47 | `record-delete/delete-stream-30k`                                    | `mixed-30k-20f`          | existing   |
| `record-update/1k-rating-field-bulk-update`                         |       345.60 |       296.22 | `record-update/5k-rating-field-bulk-update`                          | `mixed-5k-20f`           | local-pass |
| `record-delete/delete-1k`                                           |       223.70 |       334.12 | `record-delete/delete-5k`                                            | `mixed-5k-20f`           | local-pass |
| `record-update/single-foreign-select-update-1of40-fanout100-4k`     |       321.93 |       280.44 | `record-update/single-foreign-select-update-1of40-fanout500-20k`     | `computed-chain-20k`     | local-pass |
| `record-update/single-foreign-first-name-update-1of40-fanout100-4k` |       316.65 |       294.12 | `record-update/single-foreign-first-name-update-1of40-fanout500-20k` | `computed-chain-20k`     | local-pass |
| `record-update/1k-wide-table-title-only-bulk-update`                |       303.87 |       293.39 | `record-update/5k-wide-table-title-only-bulk-update`                 | `mixed-5k-20f`           | local-pass |
| `record-create/1k-primary-text-only-bulk-create`                    |       302.04 |       213.09 | `record-create/5k-primary-text-only-bulk-create`                     | `empty-primary`          | local-pass |
| `record-read/10k-50fields-group-number-low-cardinality`             |       296.67 |       164.66 | `record-read/50k-50fields-group-number-low-cardinality`              | `read-50k-50f`           | local-pass |
| `record-read/10k-50fields-sort-text-ascending`                      |       290.56 |       290.49 | `record-read/50k-50fields-sort-text-ascending`                       | `read-50k-50f`           | local-pass |
| `record-update/1k-primary-text-only-bulk-update`                    |       276.08 |       214.68 | `record-update/5k-primary-text-only-bulk-update`                     | `primary-5k-1f`          | local-pass |
| `record-read/10k-50fields-sort-three-fields`                        |        92.57 |       220.25 | `record-read/50k-50fields-sort-three-fields`                         | `read-50k-50f`           | local-pass |
| `record-redo/delete-1k`                                             |       194.11 |       199.52 | `record-redo/delete-10k`                                             | `mixed-10k-20f`          | local-pass |
| `record-update/attachment-insert-100`                               |       128.09 |       156.84 | `record-update/attachment-insert-1k`                                 | `attachment-1k`          | existing   |
| `record-read/10k-50fields-filter-text-not-empty`                    |        21.99 |       152.16 | `record-read/50k-50fields-filter-text-not-empty`                     | `read-50k-50f`           | local-pass |
| `field-create/single-select-1k-options`                             |       121.40 |        88.37 | `field-create/10x-single-select-1k-options`                          | `mixed-10k-20f`          | local-pass |
| `record-duplicate/single-record-sequential-100`                     |       111.63 |        87.88 | `record-duplicate/single-record-sequential-1000`                     | `single-source`          | local-pass |
| `record-duplicate/single-50-mixed-20fields`                         |       109.39 |        90.59 | `record-duplicate/single-500-mixed-20fields`                         | `single-source`          | local-pass |
| `record-duplicate/single-50-multiple-select-10fields`               |       106.19 |        79.71 | `record-duplicate/single-500-multiple-select-10fields`               | `single-source`          | local-pass |
| `record-duplicate/single-50-rating-10fields`                        |       103.69 |        81.66 | `record-duplicate/single-500-rating-10fields`                        | `single-source`          | local-pass |
| `form-submit/sequential-50-checkbox-10fields`                       |       103.15 |        67.52 | `form-submit/sequential-500-checkbox-10fields`                       | `empty-form`             | local-pass |
| `record-duplicate/single-50-single-select-10fields`                 |       103.13 |        78.53 | `record-duplicate/single-500-single-select-10fields`                 | `single-source`          | local-pass |
| `record-duplicate/single-50-single-line-text-10fields`              |       102.87 |        78.01 | `record-duplicate/single-500-single-line-text-10fields`              | `single-source`          | local-pass |
| `record-duplicate/single-50-number-10fields`                        |       102.83 |        78.20 | `record-duplicate/single-500-number-10fields`                        | `single-source`          | local-pass |
| `form-submit/sequential-200`                                        |       101.70 |        77.47 | `form-submit/sequential-1000`                                        | `empty-form`             | local-pass |
| `record-duplicate/single-50-date-10fields`                          |       100.38 |        78.97 | `record-duplicate/single-500-date-10fields`                          | `single-source`          | local-pass |
| `record-duplicate/single-50-checkbox-10fields`                      |        99.99 |        78.42 | `record-duplicate/single-500-checkbox-10fields`                      | `single-source`          | local-pass |
| `record-duplicate/single-50-long-text-10fields`                     |        98.65 |        78.80 | `record-duplicate/single-500-long-text-10fields`                     | `single-source`          | local-pass |
| `form-submit/sequential-50-single-line-text-20fields`               |        98.50 |        67.20 | `form-submit/sequential-500-single-line-text-20fields`               | `empty-form`             | local-pass |
| `form-submit/sequential-50-multiple-select-10fields`                |        97.59 |        65.77 | `form-submit/sequential-500-multiple-select-10fields`                | `empty-form`             | local-pass |
| `form-submit/sequential-50-single-select-10fields`                  |        97.03 |        64.91 | `form-submit/sequential-500-single-select-10fields`                  | `empty-form`             | local-pass |
| `form-submit/sequential-50-date-10fields`                           |        96.76 |        66.69 | `form-submit/sequential-500-date-10fields`                           | `empty-form`             | local-pass |
| `form-submit/sequential-50-long-text-10fields`                      |        95.77 |        65.84 | `form-submit/sequential-500-long-text-10fields`                      | `empty-form`             | local-pass |
| `form-submit/sequential-50-single-line-text-10fields`               |        95.46 |        67.41 | `form-submit/sequential-500-single-line-text-10fields`               | `empty-form`             | local-pass |
| `record-duplicate/single-50-primary-only`                           |        94.45 |        73.58 | `record-duplicate/single-500-primary-only`                           | `single-source`          | local-pass |
| `form-submit/sequential-50-rating-10fields`                         |        94.09 |        65.48 | `form-submit/sequential-500-rating-10fields`                         | `empty-form`             | local-pass |
| `form-submit/sequential-50-primary-only`                            |        93.56 |        64.31 | `form-submit/sequential-500-primary-only`                            | `empty-form`             | local-pass |
| `form-submit/sequential-50-number-10fields`                         |        92.59 |        63.38 | `form-submit/sequential-500-number-10fields`                         | `empty-form`             | local-pass |
| `table-restore/10k-20f-link-1k`                                     |        74.94 |        56.79 | `table-restore/50k-20f-link-1k`                                      | `table-lifecycle-50k`    | local-pass |
| `table-restore/10k-20f`                                             |        72.84 |        56.64 | `table-restore/50k-20f`                                              | `table-lifecycle-50k`    | local-pass |
| `duplicate-view/complex-grid-20fields-p95`                          |        67.87 |        44.42 | `duplicate-view/complex-grid-500fields-p95`                          | `wide-grid-500f`         | local-pass |
| `search/search-index-off-10k-20search-fields`                       |        56.41 |        56.94 | `search/search-index-off-50k-20search-fields`                        | `search-50k-20f`         | existing   |
| `search/search-index-off-50k-20search-fields`                       |        55.89 |        55.04 | `search/search-index-off-100k-20search-fields`                       | `search-100k-20f`        | local-pass |
| `search/search-index-on-10k-20search-fields`                        |        48.50 |        49.84 | `search/search-index-on-50k-20search-fields`                         | `search-50k-20f`         | existing   |
| `search/search-index-on-50k-20search-fields`                        |        47.96 |        49.01 | `search/search-index-on-100k-20search-fields`                        | `search-100k-20f`        | local-pass |
| `table-delete/10k-20f`                                              |        44.94 |        41.94 | `table-delete/50k-20f`                                               | `table-lifecycle-50k`    | local-pass |
| `smoke/auth-user`                                                   |        11.36 |        11.84 | `smoke/auth-user-burst-100`                                          | `no-seed`                | local-pass |
| `record-read/10k-50fields-search-title-visible-rows`                |         0.00 |         0.00 | `record-read/50k-50fields-search-title-visible-rows`                 | `read-50k-50f`           | local-pass |
| `record-read/10k-50fields-filter-number-sort-descending`            |         0.00 |         0.00 | `record-read/50k-50fields-filter-number-sort-descending`             | `read-50k-50f`           | local-pass |
| `record-read/10k-50fields-filter-number-range-middle-half`          |         0.00 |         0.00 | `record-read/50k-50fields-filter-number-range-middle-half`           | `read-50k-50f`           | local-pass |
| `record-read/10k-50fields-filter-number-greater-half`               |         0.00 |         0.00 | `record-read/50k-50fields-filter-number-greater-half`                | `read-50k-50f`           | local-pass |
| `record-read/10k-50fields-filter-sort-groupby-selective`            |         0.00 |         0.00 | `record-read/50k-50fields-filter-sort-groupby-selective`             | `read-50k-50f`           | local-pass |
