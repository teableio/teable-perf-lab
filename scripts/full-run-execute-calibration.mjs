// Complete case artifact durationMs calibration from Actions run 29917985095.
// These durations exclude trace settle/fetch time and cover the 316 cases in
// that run's default full selection for both engines.
export const FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID = {
  "csv-import/mixed-10k-20fields-create-table-import": {
    v1Ms: 28235.69,
    v2Ms: 5708.4,
  },
  "csv-import/mixed-10k-20fields-inplace-import": {
    v1Ms: 32986.51,
    v2Ms: 8184.35,
  },
  "csv-import/mixed-1k-20fields-create-table-import": {
    v1Ms: 4312.47,
    v2Ms: 2310.75,
  },
  "duplicate-base/10k-3tables-link-2workflow": { v1Ms: 5098.88, v2Ms: 4102.36 },
  "duplicate-base/10k-3tables-link-2workflow-stream": {
    v1Ms: 5620.81,
    v2Ms: 4937.71,
  },
  "duplicate-table/10k-20f-selflink": { v1Ms: 3913.45, v2Ms: 4039.16 },
  "duplicate-table/10k-20f-selflink-2k-links": { v1Ms: 3525.87, v2Ms: 5056.43 },
  "duplicate-table/10k-25f-5formula": { v1Ms: 5561.9, v2Ms: 5240.83 },
  "duplicate-table/50k-20f": { v1Ms: 18125.39, v2Ms: 30022.15 },
  "duplicate-view/complex-grid-20fields-p95": { v1Ms: 904.89, v2Ms: 636.92 },
  "duplicate-view/complex-grid-500fields-p95": { v1Ms: 1182.71, v2Ms: 821.53 },
  "export-base/10k-3tables-link-2workflow-stream": {
    v1Ms: 3597.61,
    v2Ms: 3293.1,
  },
  "field-convert/10k-checkbox-to-text": { v1Ms: 2039.04, v2Ms: 1807.94 },
  "field-convert/10k-link-to-text": { v1Ms: 2456.21, v2Ms: 1848.41 },
  "field-convert/10k-long-text-to-text": { v1Ms: 2613.11, v2Ms: 1888.5 },
  "field-convert/10k-multi-select-to-text": { v1Ms: 2259.03, v2Ms: 1480.25 },
  "field-convert/10k-multiple-select-choice-prune": {
    v1Ms: 2016.52,
    v2Ms: 2428.11,
  },
  "field-convert/10k-number-to-rating-clamped": { v1Ms: 2681.1, v2Ms: 1772.93 },
  "field-convert/10k-number-to-text": { v1Ms: 2682.43, v2Ms: 1702.12 },
  "field-convert/10k-rating-to-text": { v1Ms: 2474.9, v2Ms: 1762.72 },
  "field-convert/10k-single-select-choice-prune": {
    v1Ms: 2407.37,
    v2Ms: 2093.65,
  },
  "field-convert/10k-single-select-to-text": { v1Ms: 1155, v2Ms: 1461.59 },
  "field-convert/10k-text-to-attachment-clear": {
    v1Ms: 2126.14,
    v2Ms: 1686.09,
  },
  "field-convert/10k-text-to-auto-number": { v1Ms: 3373.62, v2Ms: 1608.86 },
  "field-convert/10k-text-to-checkbox-mixed": { v1Ms: 2291.79, v2Ms: 1731.4 },
  "field-convert/10k-text-to-date-mixed": { v1Ms: 2994.91, v2Ms: 1964.87 },
  "field-convert/10k-text-to-formula": { v1Ms: 4523.32, v2Ms: 1716.96 },
  "field-convert/10k-text-to-link": { v1Ms: 8969.12, v2Ms: 2312.13 },
  "field-convert/10k-text-to-multiple-select": { v1Ms: 3230.74, v2Ms: 1676.4 },
  "field-convert/10k-text-to-number-mixed": { v1Ms: 2607.96, v2Ms: 1843.69 },
  "field-convert/10k-text-to-single-select": { v1Ms: 2057.2, v2Ms: 1398.15 },
  "field-convert/formula-dependency-add-4k-depth5-cascade": {
    v1Ms: 6334.33,
    v2Ms: 12352.47,
  },
  "field-convert/formula-dependency-remove-4k-depth5-cascade": {
    v1Ms: 6960.53,
    v2Ms: 3435.42,
  },
  "field-convert/formula-dependency-replace-4k-depth5-cascade": {
    v1Ms: 6651.9,
    v2Ms: 3517.78,
  },
  "field-convert/formula-expression-update-4k-depth5-cascade": {
    v1Ms: 5806.96,
    v2Ms: 12231.04,
  },
  "field-create/10k-create-1-single-line-text-field": {
    v1Ms: 3294.42,
    v2Ms: 3166.8,
  },
  "field-create/10k-create-10-checkbox-fields": {
    v1Ms: 10238.7,
    v2Ms: 4024.76,
  },
  "field-create/10k-create-10-date-fields": { v1Ms: 10023.61, v2Ms: 4257.81 },
  "field-create/10k-create-10-long-text-fields": {
    v1Ms: 10252.03,
    v2Ms: 4560.03,
  },
  "field-create/10k-create-10-multiple-select-fields": {
    v1Ms: 10256.9,
    v2Ms: 4370.92,
  },
  "field-create/10k-create-10-number-fields": { v1Ms: 10364.27, v2Ms: 4054.27 },
  "field-create/10k-create-10-rating-fields": { v1Ms: 9712.56, v2Ms: 4100.27 },
  "field-create/10k-create-10-single-line-text-fields": {
    v1Ms: 10597.41,
    v2Ms: 6370.14,
  },
  "field-create/10k-create-10-single-select-fields": {
    v1Ms: 10137.22,
    v2Ms: 4015.46,
  },
  "field-create/10k-create-20-single-line-text-fields": {
    v1Ms: 18792.52,
    v2Ms: 9884.21,
  },
  "field-create/10k-create-5-formula-fields": { v1Ms: 5053.99, v2Ms: 3009.99 },
  "field-create/10k-create-5-simple-fields": { v1Ms: 5808.29, v2Ms: 2483.49 },
  "field-create/10x-single-select-1k-options": { v1Ms: 3476.99, v2Ms: 4281.25 },
  "field-create/50k-create-1-single-line-text-field": {
    v1Ms: 12998.26,
    v2Ms: 17933.29,
  },
  "field-create/50k-create-10-checkbox-fields": {
    v1Ms: 49826.31,
    v2Ms: 20306.46,
  },
  "field-create/50k-create-10-date-fields": { v1Ms: 47253.01, v2Ms: 25311.13 },
  "field-create/50k-create-10-long-text-fields": {
    v1Ms: 39862.03,
    v2Ms: 24016.81,
  },
  "field-create/50k-create-10-multiple-select-fields": {
    v1Ms: 44528.08,
    v2Ms: 22860.8,
  },
  "field-create/50k-create-10-number-fields": {
    v1Ms: 45122.43,
    v2Ms: 20291.43,
  },
  "field-create/50k-create-10-rating-fields": { v1Ms: 53356.7, v2Ms: 18029.95 },
  "field-create/50k-create-10-single-line-text-fields": {
    v1Ms: 55983.53,
    v2Ms: 18175.72,
  },
  "field-create/50k-create-10-single-select-fields": {
    v1Ms: 37100.74,
    v2Ms: 20182.5,
  },
  "field-create/50k-create-20-single-line-text-fields": {
    v1Ms: 71865.36,
    v2Ms: 23156.79,
  },
  "field-create/mixed-10k-create-19-fields": { v1Ms: 14523.55, v2Ms: 2842.19 },
  "field-create/single-select-1k-options": { v1Ms: 300.84, v2Ms: 334.11 },
  "field-delete/50k-delete-active-field": { v1Ms: 10318.38, v2Ms: 17113.03 },
  "field-delete/50k-delete-amount-field": { v1Ms: 10024.41, v2Ms: 14144.07 },
  "field-delete/50k-delete-description-field": {
    v1Ms: 10145.74,
    v2Ms: 14709.26,
  },
  "field-delete/50k-delete-owner-text-field": { v1Ms: 9830.18, v2Ms: 15931.96 },
  "field-delete/50k-delete-score-field": { v1Ms: 9795.04, v2Ms: 16205.05 },
  "field-delete/50k-delete-start-date-field": { v1Ms: 7351.16, v2Ms: 15266.76 },
  "field-delete/50k-delete-status-field": { v1Ms: 10150.75, v2Ms: 14348.94 },
  "field-delete/50k-delete-tags-field": { v1Ms: 8488.51, v2Ms: 14365.24 },
  "field-delete/mixed-10k-delete-19-fields": { v1Ms: 4722.97, v2Ms: 4556.66 },
  "field-duplicate/10k-duplicate-active-field": {
    v1Ms: 4857.93,
    v2Ms: 2572.12,
  },
  "field-duplicate/10k-duplicate-amount-field": {
    v1Ms: 3240.46,
    v2Ms: 2598.76,
  },
  "field-duplicate/10k-duplicate-assignee-field": {
    v1Ms: 5208.29,
    v2Ms: 4148.43,
  },
  "field-duplicate/10k-duplicate-attachments-field": {
    v1Ms: 7219.52,
    v2Ms: 4807.87,
  },
  "field-duplicate/10k-duplicate-conditional-rollup-field": {
    v1Ms: 6615.58,
    v2Ms: 3217.34,
  },
  "field-duplicate/10k-duplicate-description-field": {
    v1Ms: 4548.54,
    v2Ms: 2666.71,
  },
  "field-duplicate/10k-duplicate-formula-field": {
    v1Ms: 3407.75,
    v2Ms: 2859.54,
  },
  "field-duplicate/10k-duplicate-many-many-link-field": {
    v1Ms: 37140.73,
    v2Ms: 4586.82,
  },
  "field-duplicate/10k-duplicate-many-one-link-field": {
    v1Ms: 49985.99,
    v2Ms: 10186.43,
  },
  "field-duplicate/10k-duplicate-one-many-one-way-link-field": {
    v1Ms: 8917.73,
    v2Ms: 3274.99,
  },
  "field-duplicate/10k-duplicate-owner-text-field": {
    v1Ms: 4600.58,
    v2Ms: 2514.73,
  },
  "field-duplicate/10k-duplicate-rollup-field": {
    v1Ms: 4119.84,
    v2Ms: 3455.25,
  },
  "field-duplicate/10k-duplicate-score-field": { v1Ms: 4700.07, v2Ms: 2452.98 },
  "field-duplicate/10k-duplicate-start-date-field": {
    v1Ms: 5085.23,
    v2Ms: 3649.69,
  },
  "field-duplicate/10k-duplicate-status-field": {
    v1Ms: 3911.49,
    v2Ms: 2399.72,
  },
  "field-duplicate/10k-duplicate-tags-field": { v1Ms: 4881.3, v2Ms: 2934.08 },
  "field-duplicate/50k-duplicate-active-field": {
    v1Ms: 19692.35,
    v2Ms: 17000.53,
  },
  "field-duplicate/50k-duplicate-amount-field": {
    v1Ms: 26545.89,
    v2Ms: 18226.12,
  },
  "field-duplicate/50k-duplicate-description-field": {
    v1Ms: 20117.26,
    v2Ms: 17585.19,
  },
  "field-duplicate/50k-duplicate-owner-text-field": {
    v1Ms: 26705.75,
    v2Ms: 17080.74,
  },
  "field-duplicate/50k-duplicate-score-field": {
    v1Ms: 30297.2,
    v2Ms: 17186.94,
  },
  "field-duplicate/50k-duplicate-start-date-field": {
    v1Ms: 28632.15,
    v2Ms: 17311.65,
  },
  "field-duplicate/50k-duplicate-status-field": {
    v1Ms: 25742.39,
    v2Ms: 19010.59,
  },
  "field-duplicate/50k-duplicate-tags-field": {
    v1Ms: 26578.56,
    v2Ms: 17697.12,
  },
  "field-duplicate/conditional-lookup-10k": { v1Ms: 3296.4, v2Ms: 2541.55 },
  "field-duplicate/v2-only-10k-duplicate-one-one-link-field": {
    v1Ms: 0.44,
    v2Ms: 11676.09,
  },
  "field-restore/10k-active-field": { v1Ms: 3818.94, v2Ms: 3140.57 },
  "field-restore/10k-amount-field": { v1Ms: 6146.5, v2Ms: 4168.52 },
  "field-restore/10k-description-field": { v1Ms: 8209.47, v2Ms: 5276.24 },
  "field-restore/10k-owner-text-field": { v1Ms: 5710.59, v2Ms: 4129.41 },
  "field-restore/10k-score-field": { v1Ms: 6525.71, v2Ms: 4927.81 },
  "field-restore/10k-start-date-field": { v1Ms: 8368.66, v2Ms: 6108.09 },
  "field-restore/10k-status-field": { v1Ms: 8264.82, v2Ms: 4998.86 },
  "field-restore/10k-tags-field": { v1Ms: 7071.58, v2Ms: 4563.04 },
  "field-update/v2-only-10k-select-option-rename-computed-cascade": {
    v1Ms: 0.27,
    v2Ms: 2020.44,
  },
  "form-submit/sequential-1000": { v1Ms: 101519.39, v2Ms: 55380.44 },
  "form-submit/sequential-200": { v1Ms: 19576.04, v2Ms: 12258.87 },
  "form-submit/sequential-500-checkbox-100fields": {
    v1Ms: 55188.23,
    v2Ms: 35126.69,
  },
  "form-submit/sequential-500-checkbox-10fields": {
    v1Ms: 43968.71,
    v2Ms: 26900.11,
  },
  "form-submit/sequential-500-date-100fields": {
    v1Ms: 66847.13,
    v2Ms: 45417.52,
  },
  "form-submit/sequential-500-date-10fields": {
    v1Ms: 50935.37,
    v2Ms: 28919.59,
  },
  "form-submit/sequential-500-long-text-100fields": {
    v1Ms: 58922.35,
    v2Ms: 37164.5,
  },
  "form-submit/sequential-500-long-text-10fields": {
    v1Ms: 44901.92,
    v2Ms: 25848.84,
  },
  "form-submit/sequential-500-multiple-select-100fields": {
    v1Ms: 76553.5,
    v2Ms: 38201.24,
  },
  "form-submit/sequential-500-multiple-select-10fields": {
    v1Ms: 43444.59,
    v2Ms: 26939.73,
  },
  "form-submit/sequential-500-number-100fields": {
    v1Ms: 63368.97,
    v2Ms: 38451.74,
  },
  "form-submit/sequential-500-number-10fields": {
    v1Ms: 43887.45,
    v2Ms: 42565.24,
  },
  "form-submit/sequential-500-primary-only": { v1Ms: 37573.66, v2Ms: 24716.7 },
  "form-submit/sequential-500-rating-100fields": {
    v1Ms: 69451.4,
    v2Ms: 34235.64,
  },
  "form-submit/sequential-500-rating-10fields": {
    v1Ms: 43401.49,
    v2Ms: 30879.63,
  },
  "form-submit/sequential-500-single-line-text-100fields": {
    v1Ms: 66209.36,
    v2Ms: 33526.71,
  },
  "form-submit/sequential-500-single-line-text-10fields": {
    v1Ms: 43157.48,
    v2Ms: 31471.27,
  },
  "form-submit/sequential-500-single-line-text-20fields": {
    v1Ms: 46790.08,
    v2Ms: 26453.17,
  },
  "form-submit/sequential-500-single-select-100fields": {
    v1Ms: 70896.6,
    v2Ms: 41936.79,
  },
  "form-submit/sequential-500-single-select-10fields": {
    v1Ms: 46872.75,
    v2Ms: 25608.35,
  },
  "formula/10k-5-concurrent": { v1Ms: 8444.87, v2Ms: 3811.15 },
  "formula/10k-calc": { v1Ms: 2584.85, v2Ms: 2475.98 },
  "formula/50k-calc": { v1Ms: 8219.1, v2Ms: 9583.92 },
  "import-base/v2-only-complex-3x10k-3tables-2workflow-stream": {
    v1Ms: 0.49,
    v2Ms: 15711.07,
  },
  "import-base/v2-only-simple-1x10k-table-stream": { v1Ms: 0.4, v2Ms: 5248.53 },
  "import-base/v2-only-simple-1x1k-table-stream": { v1Ms: 0.47, v2Ms: 1202.89 },
  "import-base/v2-only-user-t2377-tea-stream": { v1Ms: 0.44, v2Ms: 7139.83 },
  "lookup/conditional-10k": { v1Ms: 2361.39, v2Ms: 2552.62 },
  "lookup/conditional-group-active-flip-1k-fanout100-10k": {
    v1Ms: 6097.78,
    v2Ms: 6842.09,
  },
  "lookup/conditional-group-active-flip-1k-fanout100-30k": {
    v1Ms: 18027.66,
    v2Ms: 17523.93,
  },
  "lookup/conditional-group-active-text-10k": { v1Ms: 3349.9, v2Ms: 1981.75 },
  "lookup/conditional-group-active-text-fanout100-10k": {
    v1Ms: 3242,
    v2Ms: 2412.19,
  },
  "lookup/conditional-group-active-text-fanout50-10k": {
    v1Ms: 3544.98,
    v2Ms: 2337.52,
  },
  "lookup/conditional-group-number-top3-10k": { v1Ms: 2608.77, v2Ms: 2444.28 },
  "lookup/conditional-group-number-top3-fanout100-10k": {
    v1Ms: 1991.14,
    v2Ms: 2076.97,
  },
  "lookup/conditional-group-number-top3-fanout50-10k": {
    v1Ms: 3076.74,
    v2Ms: 2445.87,
  },
  "lookup/conditional-group-text-fanout10-10k": { v1Ms: 3159.1, v2Ms: 2579.69 },
  "lookup/conditional-group-text-fanout100-10k": {
    v1Ms: 3624.92,
    v2Ms: 3213.58,
  },
  "lookup/conditional-group-text-fanout50-10k": {
    v1Ms: 4311.31,
    v2Ms: 3109.26,
  },
  "lookup/conditional-group-text-update-1k-fanout10-10k": {
    v1Ms: 8383.56,
    v2Ms: 5935.46,
  },
  "lookup/conditional-group-text-update-1k-fanout100-10k": {
    v1Ms: 7628.3,
    v2Ms: 7874.57,
  },
  "lookup/conditional-group-text-update-1k-fanout100-20k": {
    v1Ms: 19391.87,
    v2Ms: 13390.5,
  },
  "lookup/conditional-group-text-update-1k-fanout100-30k": {
    v1Ms: 23931.86,
    v2Ms: 19897.54,
  },
  "lookup/conditional-group-text-update-1k-fanout100-limit10-10k": {
    v1Ms: 4920.86,
    v2Ms: 5700.47,
  },
  "lookup/conditional-group-text-update-1k-fanout100-limit50-10k": {
    v1Ms: 5504.5,
    v2Ms: 5873.24,
  },
  "lookup/conditional-group-text-update-1k-fanout50-10k": {
    v1Ms: 11105.58,
    v2Ms: 7869.39,
  },
  "lookup/customer-create-order-only-20k-depth5": {
    v1Ms: 11165.36,
    v2Ms: 14211,
  },
  "lookup/customer-create-user-create-order-4k-depth5": {
    v1Ms: 3130.29,
    v2Ms: 6169.78,
  },
  "lookup/customer-update-other-user-create-order-4k-depth5": {
    v1Ms: 4732.07,
    v2Ms: 8386.29,
  },
  "lookup/customer-update-user-control-field-create-order-20k-depth5": {
    v1Ms: 8900.96,
    v2Ms: 17673.38,
  },
  "lookup/customer-update-user-create-order-4k-depth5": {
    v1Ms: 4213.52,
    v2Ms: 7359.59,
  },
  "lookup/customer-update-user-first-name-only-create-order-4k-depth5": {
    v1Ms: 3757.62,
    v2Ms: 5363.19,
  },
  "lookup/customer-update-user-update-order-4k-depth5": {
    v1Ms: 5320.05,
    v2Ms: 6981.58,
  },
  "lookup/dual-link-computed-first-link-1of4k-get-record": {
    v1Ms: 1511.59,
    v2Ms: 3297.41,
  },
  "lookup/dual-link-computed-first-link-1of4k-get-records": {
    v1Ms: 2161.46,
    v2Ms: 3158.37,
  },
  "lookup/dual-link-computed-first-link-4k": { v1Ms: 59086.13, v2Ms: 26409.41 },
  "lookup/dual-link-computed-repoint-2k": { v1Ms: 22918.73, v2Ms: 20023.27 },
  "lookup/foreign-first-name-update-1of40-fanout100-4k": {
    v1Ms: 3156.25,
    v2Ms: 5648.07,
  },
  "lookup/foreign-first-name-update-1of40-fanout500-20k": {
    v1Ms: 4228.3,
    v2Ms: 5940.02,
  },
  "lookup/foreign-select-flip-1of40-fanout100-4k": {
    v1Ms: 2720.83,
    v2Ms: 4513.94,
  },
  "lookup/foreign-select-flip-1of40-fanout500-20k": {
    v1Ms: 5262.23,
    v2Ms: 5429.66,
  },
  "lookup/v2-only-conditional-dirty-host-create-100-10k": {
    v1Ms: 0.54,
    v2Ms: 5063.62,
  },
  "record-create/1k-single-line-text-fields-bulk-create": {
    v1Ms: 1859.48,
    v2Ms: 1786.08,
  },
  "record-create/5k-checkbox-fields-bulk-create": {
    v1Ms: 8831.41,
    v2Ms: 7385.86,
  },
  "record-create/5k-date-fields-bulk-create": { v1Ms: 7142.9, v2Ms: 8542.69 },
  "record-create/5k-long-text-fields-bulk-create": {
    v1Ms: 9706.64,
    v2Ms: 8417.64,
  },
  "record-create/5k-multiple-select-fields-bulk-create": {
    v1Ms: 9781.46,
    v2Ms: 9650.16,
  },
  "record-create/5k-number-fields-bulk-create": {
    v1Ms: 9834.69,
    v2Ms: 8548.03,
  },
  "record-create/5k-primary-text-only-bulk-create": {
    v1Ms: 5495.29,
    v2Ms: 4722.58,
  },
  "record-create/5k-rating-field-bulk-create": { v1Ms: 8598.64, v2Ms: 7918.1 },
  "record-create/5k-single-line-text-fields-bulk-create": {
    v1Ms: 8525.99,
    v2Ms: 8974.13,
  },
  "record-create/5k-single-select-fields-bulk-create": {
    v1Ms: 8128.09,
    v2Ms: 8482.8,
  },
  "record-create/5k-wide-table-title-only-bulk-create": {
    v1Ms: 8605.29,
    v2Ms: 7892.31,
  },
  "record-create/mixed-1k-20fields-bulk-create": {
    v1Ms: 3219.95,
    v2Ms: 3449.54,
  },
  "record-delete/delete-5k": { v1Ms: 2507.31, v2Ms: 4019.98 },
  "record-delete/delete-stream-10k": { v1Ms: 4169.6, v2Ms: 4935.3 },
  "record-delete/delete-stream-30k": { v1Ms: 13446.72, v2Ms: 14293.91 },
  "record-delete/link-trash-5k": { v1Ms: 37047, v2Ms: 10123.75 },
  "record-duplicate/grid-block-duplicate-1k": { v1Ms: 91728.39, v2Ms: 5059.15 },
  "record-duplicate/single-500-checkbox-100fields": {
    v1Ms: 67012.12,
    v2Ms: 56207.06,
  },
  "record-duplicate/single-500-checkbox-10fields": {
    v1Ms: 49958.83,
    v2Ms: 33745.85,
  },
  "record-duplicate/single-500-checkbox-500fields": {
    v1Ms: 144379.93,
    v2Ms: 124577.96,
  },
  "record-duplicate/single-500-date-100fields": {
    v1Ms: 66766.91,
    v2Ms: 54007.1,
  },
  "record-duplicate/single-500-date-10fields": {
    v1Ms: 47416.13,
    v2Ms: 34047.18,
  },
  "record-duplicate/single-500-long-text-100fields": {
    v1Ms: 75355.81,
    v2Ms: 54284.98,
  },
  "record-duplicate/single-500-long-text-10fields": {
    v1Ms: 46894.03,
    v2Ms: 31792.27,
  },
  "record-duplicate/single-500-mixed-20fields": {
    v1Ms: 51053.97,
    v2Ms: 35669.88,
  },
  "record-duplicate/single-500-multiple-select-100fields": {
    v1Ms: 84019.37,
    v2Ms: 54851.47,
  },
  "record-duplicate/single-500-multiple-select-10fields": {
    v1Ms: 50329.83,
    v2Ms: 33319.15,
  },
  "record-duplicate/single-500-number-100fields": {
    v1Ms: 70539.7,
    v2Ms: 58140.88,
  },
  "record-duplicate/single-500-number-10fields": {
    v1Ms: 47486.06,
    v2Ms: 33931.75,
  },
  "record-duplicate/single-500-primary-only": { v1Ms: 46222.5, v2Ms: 30503.3 },
  "record-duplicate/single-500-rating-100fields": {
    v1Ms: 75624.51,
    v2Ms: 52556.18,
  },
  "record-duplicate/single-500-rating-10fields": {
    v1Ms: 48635.2,
    v2Ms: 32921.16,
  },
  "record-duplicate/single-500-single-line-text-100fields": {
    v1Ms: 60724.92,
    v2Ms: 53209.7,
  },
  "record-duplicate/single-500-single-line-text-10fields": {
    v1Ms: 48466.45,
    v2Ms: 33987.18,
  },
  "record-duplicate/single-500-single-select-100fields": {
    v1Ms: 80496.2,
    v2Ms: 56976.07,
  },
  "record-duplicate/single-500-single-select-10fields": {
    v1Ms: 48853.56,
    v2Ms: 39730.83,
  },
  "record-duplicate/single-record-sequential-100": {
    v1Ms: 9903.69,
    v2Ms: 8008.42,
  },
  "record-duplicate/single-record-sequential-1000": {
    v1Ms: 105547.95,
    v2Ms: 87025.66,
  },
  "record-paste/10k-primary-only": { v1Ms: 3220.23, v2Ms: 2310.37 },
  "record-paste/1k-checkbox-10fields": { v1Ms: 1542.95, v2Ms: 622.49 },
  "record-paste/1k-date-10fields": { v1Ms: 1632.37, v2Ms: 1695.07 },
  "record-paste/1k-long-text-10fields": { v1Ms: 1615.21, v2Ms: 659.05 },
  "record-paste/1k-mixed-20fields": { v1Ms: 3011.99, v2Ms: 1553.43 },
  "record-paste/1k-multiple-select-10fields": { v1Ms: 2297.87, v2Ms: 703.94 },
  "record-paste/1k-number-10fields": { v1Ms: 1145.11, v2Ms: 635.43 },
  "record-paste/1k-rating-10fields": { v1Ms: 2046.45, v2Ms: 579.03 },
  "record-paste/1k-single-line-text-10fields": { v1Ms: 1571.59, v2Ms: 785.11 },
  "record-paste/1k-single-select-10fields": { v1Ms: 1572.36, v2Ms: 667.56 },
  "record-paste/5k-checkbox-10fields": { v1Ms: 6350.81, v2Ms: 1798.25 },
  "record-paste/5k-date-10fields": { v1Ms: 6462.66, v2Ms: 6513.05 },
  "record-paste/5k-long-text-10fields": { v1Ms: 6111.31, v2Ms: 2173.98 },
  "record-paste/5k-mixed-20fields": { v1Ms: 11430.42, v2Ms: 5365.92 },
  "record-paste/5k-multiple-select-10fields": { v1Ms: 8974.08, v2Ms: 2484.69 },
  "record-paste/5k-number-10fields": { v1Ms: 2604.32, v2Ms: 2050.91 },
  "record-paste/5k-rating-10fields": { v1Ms: 8751.76, v2Ms: 2283.48 },
  "record-paste/5k-single-line-text-10fields": { v1Ms: 5794.08, v2Ms: 2322.89 },
  "record-paste/5k-single-select-10fields": { v1Ms: 5100.86, v2Ms: 2007.72 },
  "record-paste/flat-10k-20fields-copy-paste": {
    v1Ms: 20485.62,
    v2Ms: 6590.22,
  },
  "record-paste/flat-10k-4fields-copy-paste": { v1Ms: 3865.8, v2Ms: 2585.33 },
  "record-paste/mixed-10k-20fields-complex-copy-paste": {
    v1Ms: 21972.92,
    v2Ms: 9620.64,
  },
  "record-read/100k-50fields-filter-number-greater-half": {
    v1Ms: 48508.24,
    v2Ms: 60815.85,
  },
  "record-read/100k-50fields-filter-number-range-middle-half": {
    v1Ms: 54805.34,
    v2Ms: 86533.25,
  },
  "record-read/100k-50fields-filter-number-sort-descending": {
    v1Ms: 48715.11,
    v2Ms: 60557.11,
  },
  "record-read/10k-50fields-10x1k-pages": { v1Ms: 4150.67, v2Ms: 4538.76 },
  "record-read/10k-50fields-filter-formula-greater-half": {
    v1Ms: 4784.38,
    v2Ms: 5634.48,
  },
  "record-read/10k-50fields-filter-formula-range-middle": {
    v1Ms: 4923.85,
    v2Ms: 5469.9,
  },
  "record-read/10k-50fields-filter-group-sort-formula": {
    v1Ms: 5016.26,
    v2Ms: 5910.55,
  },
  "record-read/10k-50fields-filter-lookup-not-empty": {
    v1Ms: 5815.53,
    v2Ms: 6609.67,
  },
  "record-read/10k-50fields-filter-sort-formula-selective": {
    v1Ms: 4906.87,
    v2Ms: 5621.21,
  },
  "record-read/10k-50fields-filter-sort-groupby-overhead": {
    v1Ms: 6559.79,
    v2Ms: 6969.1,
  },
  "record-read/10k-50fields-group-stored-sort-formula": {
    v1Ms: 6132.54,
    v2Ms: 6616.34,
  },
  "record-read/10k-50fields-group-stored-sort-lookup": {
    v1Ms: 6439.63,
    v2Ms: 7004.12,
  },
  "record-read/10k-50fields-group-three-levels": {
    v1Ms: 6634.86,
    v2Ms: 6680.27,
  },
  "record-read/10k-50fields-search-lookup-visible-row": {
    v1Ms: 3992.39,
    v2Ms: 4511.67,
  },
  "record-read/10k-50fields-sort-formula-descending": {
    v1Ms: 5492.84,
    v2Ms: 6676.25,
  },
  "record-read/10k-50fields-sort-lookup-ascending": {
    v1Ms: 6057.32,
    v2Ms: 6994.14,
  },
  "record-read/50k-50fields-50x1k-pages": { v1Ms: 19381.19, v2Ms: 25451.03 },
  "record-read/50k-50fields-filter-sort-groupby-selective": {
    v1Ms: 25640.04,
    v2Ms: 30165,
  },
  "record-read/50k-50fields-filter-text-not-empty": {
    v1Ms: 29058.4,
    v2Ms: 33072.56,
  },
  "record-read/50k-50fields-group-number-low-cardinality": {
    v1Ms: 29676.72,
    v2Ms: 35567.23,
  },
  "record-read/50k-50fields-search-title-visible-rows": {
    v1Ms: 13812.49,
    v2Ms: 23359.13,
  },
  "record-read/50k-50fields-sort-text-ascending": {
    v1Ms: 36477.29,
    v2Ms: 39568.83,
  },
  "record-read/50k-50fields-sort-three-fields": {
    v1Ms: 33324.17,
    v2Ms: 37697.26,
  },
  "record-redo/delete-10k": { v1Ms: 20544.78, v2Ms: 11805.73 },
  "record-reorder/10k-move-last-1k-to-front": { v1Ms: 2824.91, v2Ms: 2144.37 },
  "record-restore/restore-10k": { v1Ms: 20784.22, v2Ms: 9226.36 },
  "record-restore/restore-1k": { v1Ms: 3124.58, v2Ms: 1783.27 },
  "record-restore/restore-50k": { v1Ms: 108091.61, v2Ms: 51685.28 },
  "record-undo/delete-1k": { v1Ms: 2856.58, v2Ms: 1776.02 },
  "record-update/1k-date-fields-bulk-update": { v1Ms: 1645.23, v2Ms: 2467.5 },
  "record-update/1k-link-cells-bulk-update": { v1Ms: 4690.67, v2Ms: 1818.82 },
  "record-update/1k-number-fields-bulk-update": {
    v1Ms: 1458.97,
    v2Ms: 1337.38,
  },
  "record-update/1k-rating-field-bulk-update": { v1Ms: 1408.89, v2Ms: 1147.34 },
  "record-update/1k-single-line-text-fields-bulk-update": {
    v1Ms: 2228.81,
    v2Ms: 1401.77,
  },
  "record-update/5k-checkbox-fields-bulk-update": {
    v1Ms: 4109.43,
    v2Ms: 4261.51,
  },
  "record-update/5k-date-fields-bulk-update": { v1Ms: 4358.25, v2Ms: 10077.88 },
  "record-update/5k-long-text-fields-bulk-update": {
    v1Ms: 5690.05,
    v2Ms: 6224.23,
  },
  "record-update/5k-multiple-select-fields-bulk-update": {
    v1Ms: 5625.69,
    v2Ms: 5813.85,
  },
  "record-update/5k-number-fields-bulk-update": {
    v1Ms: 5246.15,
    v2Ms: 5134.43,
  },
  "record-update/5k-primary-text-only-bulk-update": {
    v1Ms: 3213.42,
    v2Ms: 3455.81,
  },
  "record-update/5k-rating-field-bulk-update": { v1Ms: 4164.3, v2Ms: 4013.16 },
  "record-update/5k-single-line-text-fields-bulk-update": {
    v1Ms: 4191.86,
    v2Ms: 5169.22,
  },
  "record-update/5k-single-select-fields-bulk-update": {
    v1Ms: 3745.86,
    v2Ms: 4816.06,
  },
  "record-update/5k-wide-table-title-only-bulk-update": {
    v1Ms: 3509.08,
    v2Ms: 4089.77,
  },
  "record-update/attachment-insert-100": { v1Ms: 2201.15, v2Ms: 2094.44 },
  "record-update/attachment-insert-1k": { v1Ms: 7515.28, v2Ms: 7129.71 },
  "record-update/mixed-1k-20fields-bulk-update": {
    v1Ms: 5359.98,
    v2Ms: 5209.55,
  },
  "record-update/single-foreign-first-name-update-1of40-fanout100-4k": {
    v1Ms: 13296.29,
    v2Ms: 2523.83,
  },
  "record-update/single-foreign-first-name-update-1of40-fanout500-20k": {
    v1Ms: 5404.4,
    v2Ms: 5888.48,
  },
  "record-update/single-foreign-select-update-1of40-fanout100-4k": {
    v1Ms: 11201.58,
    v2Ms: 2128.99,
  },
  "record-update/single-foreign-select-update-1of40-fanout500-20k": {
    v1Ms: 3648.16,
    v2Ms: 5839.3,
  },
  "rollup/conditional-10k": { v1Ms: 4388.43, v2Ms: 2374.08 },
  "rollup/conditional-group-active-max-10k": { v1Ms: 2616.71, v2Ms: 1782.93 },
  "rollup/conditional-group-active-sum-fanout10-10k": {
    v1Ms: 2626.11,
    v2Ms: 1783.31,
  },
  "rollup/conditional-group-active-sum-fanout100-10k": {
    v1Ms: 1766.44,
    v2Ms: 1985.97,
  },
  "rollup/conditional-group-active-sum-fanout50-10k": {
    v1Ms: 3238.35,
    v2Ms: 2151.85,
  },
  "rollup/conditional-group-active-sum-update-1k-fanout10-10k": {
    v1Ms: 6471.76,
    v2Ms: 4488.89,
  },
  "rollup/conditional-group-active-sum-update-1k-fanout100-10k": {
    v1Ms: 4774.21,
    v2Ms: 4858.91,
  },
  "rollup/conditional-group-active-sum-update-1k-fanout100-20k": {
    v1Ms: 9883.71,
    v2Ms: 7567.48,
  },
  "rollup/conditional-group-active-sum-update-1k-fanout100-30k": {
    v1Ms: 12089.64,
    v2Ms: 13569.26,
  },
  "rollup/conditional-group-active-sum-update-1k-fanout50-10k": {
    v1Ms: 7303.81,
    v2Ms: 4771.27,
  },
  "rollup/conditional-group-average-fanout10-10k": {
    v1Ms: 2664.76,
    v2Ms: 1766.39,
  },
  "rollup/conditional-group-countall-fanout10-10k": {
    v1Ms: 3061.14,
    v2Ms: 1883.04,
  },
  "rollup/conditional-group-sum-fanout10-10k": { v1Ms: 2641.64, v2Ms: 1759.86 },
  "rollup/conditional-group-text-top3-10k": { v1Ms: 8007.97, v2Ms: 2188.74 },
  "search/search-index-off-100k-20search-fields": {
    v1Ms: 12813.75,
    v2Ms: 14791.59,
  },
  "search/search-index-on-100k-20search-fields": {
    v1Ms: 8057.62,
    v2Ms: 8413.91,
  },
  "selection-clear/flat-10k-20fields-cell-clear-stream": {
    v1Ms: 19848.43,
    v2Ms: 15876.55,
  },
  "selection-clear/flat-1k-20fields-cell-clear-stream": {
    v1Ms: 1832.52,
    v2Ms: 2098.62,
  },
  "selection-paste/10k-expand-rows-and-fields-stream": {
    v1Ms: 22391.21,
    v2Ms: 8059.24,
  },
  "smoke/auth-user": { v1Ms: 77.5, v2Ms: 95.42 },
  "smoke/auth-user-burst-100": { v1Ms: 91.68, v2Ms: 94.24 },
  "table-create/10x-20f-no-records": { v1Ms: 2826.18, v2Ms: 1287.64 },
  "table-create/1x-10f-1k-checkbox": { v1Ms: 1226.45, v2Ms: 693.52 },
  "table-create/1x-10f-1k-date": { v1Ms: 1037.97, v2Ms: 1827.48 },
  "table-create/1x-10f-1k-long-text": { v1Ms: 1628.69, v2Ms: 1321.92 },
  "table-create/1x-10f-1k-multiple-select": { v1Ms: 2262.57, v2Ms: 1138.61 },
  "table-create/1x-10f-1k-number": { v1Ms: 874.87, v2Ms: 978.46 },
  "table-create/1x-10f-1k-rating": { v1Ms: 1436.06, v2Ms: 1885.98 },
  "table-create/1x-10f-1k-single-line-text": { v1Ms: 1230.27, v2Ms: 1371.57 },
  "table-create/1x-10f-1k-single-select": { v1Ms: 1325.52, v2Ms: 1231.13 },
  "table-create/1x-1f-5k-primary-only": { v1Ms: 1713.09, v2Ms: 1586.86 },
  "table-create/1x-20f-1k-records": { v1Ms: 2725.6, v2Ms: 2437.27 },
  "table-create/1x-20f-1k-single-line-text": { v1Ms: 2212.49, v2Ms: 1474.3 },
  "table-create/1x-20f-5k-records": { v1Ms: 9476.6, v2Ms: 9511.29 },
  "table-delete/10k-20f-link-detach": { v1Ms: 62252.12, v2Ms: 36128.99 },
  "table-delete/30k-20f-link-detach": { v1Ms: 15211.45, v2Ms: 10928.38 },
  "table-delete/50k-20f": { v1Ms: 52747.53, v2Ms: 66188.88 },
  "table-restore/50k-20f": { v1Ms: 60440.43, v2Ms: 73598.49 },
  "table-restore/50k-20f-link-1k": { v1Ms: 58177.33, v2Ms: 81593.3 },
};
