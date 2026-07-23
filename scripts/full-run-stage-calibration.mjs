// Cold provenance is written only by refresh-full-run-calibration.mjs.
// Warm provenance is added only after exact-hit status, result coverage, plan,
// namespace, and commit identities match that cold source.
import { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";

export const FULL_RUN_STAGE_CALIBRATION = {
  sourceRunId: "29979412537",
  sourceUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29979412537",
  sourcePerfLabSha: "b2c1530e85503db8d982d98c2b3047c7284ba73c",
  sourceTeableEeSha: "25ca3466c9cc6b96fa8e229ab1a8c9dd378b4a8a",
  sourceCacheNamespace: "accept-b2c1530-20260723-01",
  sourceArtifactRunId: "29979412537-1",
  sourceSeedPlan: [
    {
      name: "shard-1-of-8",
      stableSlot: "slot-1",
      caseSetDigest: "9dd57c4d5322c9c7",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "lookup/conditional-group-text-fanout10-10k,lookup/conditional-group-text-update-1k-fanout10-10k,lookup/conditional-group-number-top3-10k,lookup/conditional-group-active-text-10k,rollup/conditional-group-countall-fanout10-10k,rollup/conditional-group-sum-fanout10-10k,rollup/conditional-group-average-fanout10-10k,rollup/conditional-group-active-max-10k,rollup/conditional-group-active-sum-fanout10-10k,rollup/conditional-group-active-sum-update-1k-fanout10-10k,rollup/conditional-group-text-top3-10k,lookup/foreign-select-flip-1of40-fanout100-4k,lookup/foreign-first-name-update-1of40-fanout100-4k,field-convert/10k-checkbox-to-text,field-convert/10k-text-to-date-mixed,field-convert/10k-text-to-attachment-clear,field-convert/formula-expression-update-4k-depth5-cascade,field-convert/formula-dependency-add-4k-depth5-cascade,field-convert/formula-dependency-replace-4k-depth5-cascade,field-convert/formula-dependency-remove-4k-depth5-cascade,field-delete/mixed-10k-delete-19-fields,field-delete/50k-delete-tags-field,field-restore/10k-active-field,field-duplicate/10k-duplicate-status-field,field-duplicate/50k-duplicate-owner-text-field,field-duplicate/50k-duplicate-description-field,field-duplicate/50k-duplicate-amount-field,field-duplicate/50k-duplicate-start-date-field,field-duplicate/50k-duplicate-active-field,field-duplicate/50k-duplicate-status-field,field-duplicate/50k-duplicate-tags-field,field-duplicate/50k-duplicate-score-field,field-duplicate/10k-duplicate-many-one-link-field,duplicate-table/10k-20f-selflink,duplicate-base/10k-3tables-link-2workflow,table-create/10x-20f-no-records,table-create/1x-10f-1k-date,table-delete/30k-20f-link-detach,table-restore/50k-20f,form-submit/sequential-500-primary-only,form-submit/sequential-500-multiple-select-10fields,form-submit/sequential-500-checkbox-100fields,record-duplicate/single-500-long-text-10fields,record-duplicate/single-500-mixed-20fields,record-update/single-foreign-first-name-update-1of40-fanout100-4k,record-update/single-foreign-select-update-1of40-fanout100-4k,record-paste/1k-number-10fields,record-paste/5k-long-text-10fields,record-paste/flat-10k-20fields-copy-paste",
    },
    {
      name: "shard-2-of-8",
      stableSlot: "slot-2",
      caseSetDigest: "fa060a66381386b6",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "lookup/conditional-group-text-fanout50-10k,lookup/conditional-group-text-update-1k-fanout50-10k,lookup/conditional-group-text-update-1k-fanout100-20k,lookup/conditional-group-number-top3-fanout50-10k,lookup/conditional-group-active-text-fanout50-10k,rollup/conditional-group-active-sum-fanout50-10k,rollup/conditional-group-active-sum-update-1k-fanout50-10k,rollup/conditional-group-active-sum-update-1k-fanout100-20k,lookup/customer-update-user-create-order-4k-depth5,lookup/customer-update-user-update-order-4k-depth5,lookup/customer-create-user-create-order-4k-depth5,lookup/customer-update-user-first-name-only-create-order-4k-depth5,lookup/customer-update-other-user-create-order-4k-depth5,field-create/10k-create-5-simple-fields,field-create/10x-single-select-1k-options,field-convert/10k-text-to-number-mixed,field-convert/10k-single-select-choice-prune,field-delete/50k-delete-amount-field,field-restore/10k-start-date-field,field-duplicate/10k-duplicate-description-field,field-duplicate/10k-duplicate-rollup-field,field-duplicate/10k-duplicate-conditional-rollup-field,duplicate-table/50k-20f,import-base/v2-only-simple-1x10k-table-stream,table-create/1x-1f-5k-primary-only,table-create/1x-10f-1k-multiple-select,csv-import/mixed-10k-20fields-create-table-import,form-submit/sequential-500-number-10fields,form-submit/sequential-500-rating-100fields,record-restore/restore-50k,record-duplicate/grid-block-duplicate-1k,record-duplicate/single-500-checkbox-10fields,record-duplicate/single-500-checkbox-500fields,record-update/attachment-insert-100,record-undo/delete-1k,record-paste/1k-single-select-10fields,record-paste/5k-checkbox-10fields,selection-paste/10k-expand-rows-and-fields-stream",
    },
    {
      name: "shard-3-of-8",
      stableSlot: "slot-3",
      caseSetDigest: "7b997d76e9c15524",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "lookup/conditional-group-text-update-1k-fanout100-30k,lookup/conditional-group-active-flip-1k-fanout100-30k,rollup/conditional-group-active-sum-update-1k-fanout100-30k,lookup/dual-link-computed-first-link-1of4k-get-record,lookup/customer-create-order-only-20k-depth5,lookup/customer-update-user-control-field-create-order-20k-depth5,field-convert/10k-single-select-to-text,field-convert/10k-text-to-multiple-select,field-delete/50k-delete-active-field,form-submit/sequential-500-single-select-100fields,record-restore/restore-1k,record-read/10k-50fields-10x1k-pages,record-read/10k-50fields-group-three-levels,record-read/10k-50fields-filter-formula-greater-half,record-read/10k-50fields-filter-formula-range-middle,record-read/10k-50fields-sort-formula-descending,record-read/10k-50fields-filter-sort-formula-selective,record-read/10k-50fields-group-stored-sort-formula,record-read/10k-50fields-filter-lookup-not-empty,record-read/10k-50fields-search-lookup-visible-row,record-read/10k-50fields-sort-lookup-ascending,record-read/10k-50fields-group-stored-sort-lookup,record-read/10k-50fields-filter-group-sort-formula,record-read/10k-50fields-filter-sort-groupby-overhead,record-create/5k-single-line-text-fields-bulk-create,record-create/5k-long-text-fields-bulk-create,record-create/5k-checkbox-fields-bulk-create,record-create/5k-date-fields-bulk-create,record-create/5k-multiple-select-fields-bulk-create,record-create/5k-number-fields-bulk-create,record-create/5k-rating-field-bulk-create,record-create/5k-single-select-fields-bulk-create,record-create/5k-wide-table-title-only-bulk-create,record-duplicate/single-500-primary-only,record-duplicate/single-500-multiple-select-10fields,record-duplicate/single-500-single-select-100fields,record-duplicate/single-500-multiple-select-100fields,record-paste/1k-single-line-text-10fields,record-paste/1k-mixed-20fields,record-paste/5k-rating-10fields",
    },
    {
      name: "shard-4-of-8",
      stableSlot: "slot-4",
      caseSetDigest: "b4fa8a6ced870621",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "lookup/dual-link-computed-first-link-4k,field-create/10k-create-1-single-line-text-field,field-create/10k-create-10-single-line-text-fields,field-create/10k-create-10-long-text-fields,field-create/10k-create-10-number-fields,field-create/10k-create-10-date-fields,field-create/10k-create-10-checkbox-fields,field-create/10k-create-10-single-select-fields,field-create/10k-create-10-multiple-select-fields,field-create/10k-create-10-rating-fields,field-create/10k-create-20-single-line-text-fields,field-create/mixed-10k-create-19-fields,field-convert/10k-rating-to-text,field-convert/10k-text-to-auto-number,field-convert/10k-link-to-text,field-delete/50k-delete-owner-text-field,field-delete/50k-delete-score-field,field-restore/10k-score-field,field-duplicate/10k-duplicate-tags-field,field-duplicate/v2-only-10k-duplicate-one-one-link-field,duplicate-base/10k-3tables-link-2workflow-stream,table-create/1x-20f-1k-records,table-create/1x-10f-1k-checkbox,table-delete/10k-20f-link-detach,table-restore/50k-20f-link-1k,form-submit/sequential-500-single-line-text-10fields,form-submit/sequential-500-rating-10fields,record-restore/restore-10k,record-delete/delete-5k,record-delete/delete-stream-10k,record-delete/link-trash-5k,record-duplicate/single-500-number-10fields,record-duplicate/single-500-single-line-text-100fields,record-update/5k-single-line-text-fields-bulk-update,record-update/5k-long-text-fields-bulk-update,record-update/5k-checkbox-fields-bulk-update,record-update/5k-date-fields-bulk-update,record-update/5k-multiple-select-fields-bulk-update,record-update/5k-number-fields-bulk-update,record-update/5k-rating-field-bulk-update,record-update/5k-single-select-fields-bulk-update,record-update/5k-wide-table-title-only-bulk-update,record-paste/1k-date-10fields,record-paste/5k-number-10fields,record-paste/flat-10k-4fields-copy-paste",
    },
    {
      name: "shard-5-of-8",
      stableSlot: "slot-5",
      caseSetDigest: "aabdd393483c8b4b",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "lookup/dual-link-computed-first-link-1of4k-get-records,lookup/dual-link-computed-repoint-2k,lookup/foreign-select-flip-1of40-fanout500-20k,lookup/foreign-first-name-update-1of40-fanout500-20k,field-convert/10k-number-to-text,field-convert/10k-text-to-checkbox-mixed,field-convert/10k-text-to-link,field-update/v2-only-10k-select-option-rename-computed-cascade,field-delete/50k-delete-status-field,field-restore/10k-amount-field,field-duplicate/10k-duplicate-active-field,field-duplicate/10k-duplicate-many-many-link-field,field-duplicate/10k-duplicate-one-many-one-way-link-field,duplicate-view/complex-grid-500fields-p95,export-base/10k-3tables-link-2workflow-stream,table-create/1x-10f-1k-number,table-delete/50k-20f,form-submit/sequential-1000,form-submit/sequential-500-single-select-10fields,form-submit/sequential-500-single-line-text-100fields,form-submit/sequential-500-long-text-100fields,form-submit/sequential-500-date-100fields,record-create/mixed-1k-20fields-bulk-create,record-create/1k-single-line-text-fields-bulk-create,record-create/5k-primary-text-only-bulk-create,record-duplicate/single-500-single-line-text-10fields,record-duplicate/single-500-rating-10fields,record-duplicate/single-500-date-100fields,record-duplicate/single-500-rating-100fields,record-update/mixed-1k-20fields-bulk-update,record-update/1k-single-line-text-fields-bulk-update,record-update/1k-number-fields-bulk-update,record-update/1k-date-fields-bulk-update,record-update/1k-rating-field-bulk-update,record-update/5k-primary-text-only-bulk-update,record-update/single-foreign-first-name-update-1of40-fanout500-20k,record-update/single-foreign-select-update-1of40-fanout500-20k,record-paste/1k-long-text-10fields,record-paste/5k-single-line-text-10fields,record-paste/5k-mixed-20fields",
    },
    {
      name: "shard-6-of-8",
      stableSlot: "slot-6",
      caseSetDigest: "c404d6b26116ee6e",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "smoke/auth-user-burst-100,formula/10k-5-concurrent,lookup/conditional-10k,lookup/v2-only-conditional-dirty-host-create-100-10k,rollup/conditional-10k,lookup/conditional-group-text-fanout100-10k,lookup/conditional-group-text-update-1k-fanout100-10k,lookup/conditional-group-text-update-1k-fanout100-limit10-10k,lookup/conditional-group-text-update-1k-fanout100-limit50-10k,lookup/conditional-group-number-top3-fanout100-10k,lookup/conditional-group-active-text-fanout100-10k,lookup/conditional-group-active-flip-1k-fanout100-10k,rollup/conditional-group-active-sum-fanout100-10k,rollup/conditional-group-active-sum-update-1k-fanout100-10k,field-convert/10k-text-to-formula,field-restore/10k-status-field,field-restore/10k-tags-field,field-duplicate/10k-duplicate-start-date-field,field-duplicate/10k-duplicate-attachments-field,duplicate-view/complex-grid-20fields-p95,import-base/v2-only-user-t2377-tea-stream,table-create/1x-10f-1k-long-text,table-create/1x-20f-1k-single-line-text,form-submit/sequential-200,form-submit/sequential-500-checkbox-10fields,form-submit/sequential-500-number-100fields,selection-clear/flat-10k-20fields-cell-clear-stream,record-read/50k-50fields-50x1k-pages,record-read/50k-50fields-filter-text-not-empty,record-read/50k-50fields-search-title-visible-rows,record-read/50k-50fields-sort-text-ascending,record-read/50k-50fields-sort-three-fields,record-read/50k-50fields-group-number-low-cardinality,record-read/50k-50fields-filter-sort-groupby-selective,record-duplicate/single-record-sequential-1000,record-duplicate/single-500-single-select-10fields,record-duplicate/single-500-number-100fields,record-duplicate/single-500-checkbox-100fields,record-update/1k-link-cells-bulk-update,record-paste/10k-primary-only,record-paste/1k-rating-10fields,record-paste/5k-multiple-select-10fields",
    },
    {
      name: "shard-7-of-8",
      stableSlot: "slot-7",
      caseSetDigest: "6229f710ab208034",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "smoke/auth-user,formula/10k-calc,field-create/single-select-1k-options,field-convert/10k-long-text-to-text,field-convert/10k-number-to-rating-clamped,field-delete/50k-delete-description-field,field-restore/10k-description-field,field-duplicate/10k-duplicate-owner-text-field,field-duplicate/10k-duplicate-score-field,field-duplicate/10k-duplicate-formula-field,duplicate-table/10k-25f-5formula,import-base/v2-only-simple-1x1k-table-stream,table-create/1x-20f-5k-records,table-create/1x-10f-1k-single-select,csv-import/mixed-1k-20fields-create-table-import,form-submit/sequential-500-long-text-10fields,form-submit/sequential-500-single-line-text-20fields,form-submit/sequential-500-multiple-select-100fields,record-read/100k-50fields-filter-number-greater-half,record-read/100k-50fields-filter-number-range-middle-half,record-read/100k-50fields-filter-number-sort-descending,record-duplicate/single-500-date-10fields,record-duplicate/single-500-long-text-100fields,record-reorder/10k-move-last-1k-to-front,record-paste/1k-checkbox-10fields,record-paste/5k-date-10fields,record-paste/mixed-10k-20fields-complex-copy-paste",
    },
    {
      name: "shard-8-of-8",
      stableSlot: "slot-8",
      caseSetDigest: "1693051fbd391e1f",
      seedContractGeneration: "seed-contract-v1",
      caseFilter:
        "formula/50k-calc,search/search-index-off-100k-20search-fields,search/search-index-on-100k-20search-fields,field-create/10k-create-5-formula-fields,field-create/50k-create-1-single-line-text-field,field-create/50k-create-10-single-line-text-fields,field-create/50k-create-10-long-text-fields,field-create/50k-create-10-number-fields,field-create/50k-create-10-date-fields,field-create/50k-create-10-checkbox-fields,field-create/50k-create-10-single-select-fields,field-create/50k-create-10-multiple-select-fields,field-create/50k-create-10-rating-fields,field-create/50k-create-20-single-line-text-fields,field-convert/10k-multi-select-to-text,field-convert/10k-text-to-single-select,field-convert/10k-multiple-select-choice-prune,field-delete/50k-delete-start-date-field,field-restore/10k-owner-text-field,field-duplicate/conditional-lookup-10k,field-duplicate/10k-duplicate-amount-field,field-duplicate/10k-duplicate-assignee-field,duplicate-table/10k-20f-selflink-2k-links,import-base/v2-only-complex-3x10k-3tables-2workflow-stream,table-create/1x-10f-1k-single-line-text,table-create/1x-10f-1k-rating,csv-import/mixed-10k-20fields-inplace-import,form-submit/sequential-500-date-10fields,selection-clear/flat-1k-20fields-cell-clear-stream,record-delete/delete-stream-30k,record-duplicate/single-record-sequential-100,record-update/attachment-insert-1k,record-redo/delete-10k,record-paste/1k-multiple-select-10fields,record-paste/5k-single-select-10fields",
    },
  ],
  pairedWarmRunId: "29981325193",
  pairedWarmRunUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29981325193",
  cacheMode: "cold",
  observedStages: {
    sourceRunId: "29979412537",
    coldSeedMs: 1542000,
    v1Ms: 999532,
    v2SyncMs: 744504,
    v2HybridMs: 176099,
    traceMs: 28029,
  },
  fixedCosts: {
    coldSeedSetupMs: 180000,
    warmSeedMs: 30000,
    executeSetupMs: 130000,
    reportMs: 60000,
    traceJobBudgetMs: 60000,
  },
  pairedWarmArtifactRunId: "29981325193-1",
  pairedWarmObservedStages: {
    sourceRunId: "29981325193",
    warmSeedMs: 24000,
    v1Ms: 996409,
    v2SyncMs: 739536,
    v2HybridMs: 171798,
    traceMs: 28131,
  },
  caseCosts: FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID,
};
