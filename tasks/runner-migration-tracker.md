# Runner Migration Tracker

Tracks which runner kinds have been moved onto lifecycle drivers and which are
still legacy. Migration is **per runner kind**; a kind's row covers every case
that uses it, because migrating a runner means re-verifying all of its cases.

Status as of 2026-06-18 on `main`.

**Migrated: 5 / 35 runner kinds · 7 / 55 cases.**

## Migrated (✅ on the driver)

| Runner kind   | Driver / where                                   | Cases                                   | Verified              |
| ------------- | ------------------------------------------------ | --------------------------------------- | --------------------- |
| csv-import    | `csv-import-lifecycle.ts`                        | 3 csv-import cases                      | ✅ v1+v2 pass (local) |
| field-delete  | `field-delete-lifecycle.ts`                      | field-delete/mixed-10k-delete-19-fields | ✅ v1+v2 pass (local) |
| record-delete | `record-replay-lifecycle.ts` (no setup)          | record-delete/delete-1k                 | ✅ v1+v2 pass (local) |
| record-undo   | `record-replay-lifecycle.ts` (delete setup)      | record-undo/delete-1k                   | ✅ v1+v2 pass (local) |
| record-redo   | `record-replay-lifecycle.ts` (delete+undo setup) | record-redo/delete-1k                   | ✅ v1+v2 pass (local) |

## Not migrated (⬜ legacy `*.runner.ts`)

| Runner kind               | #   | Cases                                                                                                                                                                                      |
| ------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| conditional-lookup        | 1   | lookup/conditional-10k                                                                                                                                                                     |
| duplicate-base            | 3   | duplicate-base/10k-3tables-link-2workflow, duplicate-base/10k-3tables-link-2workflow-stream, export-base/10k-3tables-link-2workflow-stream                                                 |
| duplicate-table           | 2   | duplicate-table/10k-20f, duplicate-table/10k-25f-5formula                                                                                                                                  |
| field-convert             | 2   | field-convert/10k-multi-select-to-text, field-convert/10k-text-to-formula                                                                                                                  |
| field-convert-link        | 2   | field-convert/10k-link-to-text, field-convert/10k-text-to-link                                                                                                                             |
| field-create              | 4   | field-create/10k-create-5-simple-fields, field-create/10k-create-5-formula-fields, field-create/mixed-10k-create-19-fields, field-create/single-select-1k-options                          |
| field-duplicate           | 1   | field-duplicate/conditional-lookup-10k                                                                                                                                                     |
| field-update              | 1   | field-update/v2-only-10k-select-option-rename-computed-cascade                                                                                                                             |
| form-submit               | 1   | form-submit/sequential-200                                                                                                                                                                 |
| formula-table             | 2   | formula/10k-calc, formula/10k-5-concurrent                                                                                                                                                 |
| http-endpoint             | 1   | smoke/auth-user                                                                                                                                                                            |
| import-base               | 3   | import-base/v2-only-simple-1x1k-table-stream, import-base/v2-only-complex-3x10k-3tables-2workflow-stream, import-base/v2-only-user-t2377-tea-stream                                        |
| link-computed-propagation | 2   | lookup/dual-link-computed-first-link-4k, lookup/dual-link-computed-repoint-2k                                                                                                              |
| lookup-search-index       | 2   | search/search-index-off-10k-20search-fields, search/search-index-on-10k-20search-fields                                                                                                    |
| record-create             | 1   | record-create/mixed-1k-20fields-bulk-create                                                                                                                                                |
| record-delete-link        | 1   | record-delete/link-trash-1k                                                                                                                                                                |
| record-duplicate-single   | 1   | record-duplicate/single-record-sequential-100                                                                                                                                              |
| record-paste              | 4   | record-paste/flat-10k-4fields-copy-paste, record-paste/flat-10k-20fields-copy-paste, record-paste/mixed-10k-20fields-complex-copy-paste, selection-paste/10k-expand-rows-and-fields-stream |
| record-read               | 2   | record-read/10k-50fields-10x1k-pages, record-read/10k-50fields-filter-sort-groupby-overhead                                                                                                |
| record-reorder            | 1   | record-reorder/10k-move-last-1k-to-front                                                                                                                                                   |
| record-update             | 1   | record-update/mixed-1k-20fields-bulk-update                                                                                                                                                |
| record-update-attachment  | 1   | record-update/attachment-insert-100                                                                                                                                                        |
| record-update-link        | 1   | record-update/1k-link-cells-bulk-update                                                                                                                                                    |
| selection-clear           | 1   | selection-clear/flat-1k-20fields-cell-clear-stream                                                                                                                                         |
| selection-duplicate       | 1   | record-duplicate/grid-block-duplicate-1k                                                                                                                                                   |
| table-create              | 2   | table-create/10x-20f-no-records, table-create/1x-20f-1k-records                                                                                                                            |
| table-delete              | 1   | table-delete/10k-20f                                                                                                                                                                       |
| table-delete-link         | 1   | table-delete/10k-20f-link-detach                                                                                                                                                           |
| table-restore             | 1   | table-restore/10k-20f                                                                                                                                                                      |
| table-restore-link        | 1   | table-restore/10k-20f-link-1k                                                                                                                                                              |

## How migration proceeds

Incremental / boy-scout: when an agent next touches a runner, it moves that
runner onto a lifecycle driver only when the driver shape is clear. Each
migration must keep behavior identical, proven by the G1 artifact diff over its
cases × engines. The first driver becomes truly generic only after a second
family migrates. Update this file when a row moves.
