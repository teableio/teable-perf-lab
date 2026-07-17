# Runner Migration Tracker

Tracks which runner kinds have been moved onto lifecycle drivers and which are
still legacy. Migration is **per runner kind**; a kind's row covers every case
that uses it, because migrating a runner means re-verifying all of its cases.

Current counts and driver declarations are generated from the canonical typed
inventory and registered case catalog. The generated block is checked by
`pnpm check:readme` as part of `pnpm check`.

<!-- BEGIN GENERATED RUNNER INVENTORY -->

<!-- Generated from framework/runner-registry.ts and registry.ts. -->
<!-- Do not edit by hand; run `pnpm sync:readme` to regenerate. -->

**Lifecycle: 38 / 42 runner kinds · 112 / 121 cases. Direct: 4 runner kinds · 9 cases.**

| Runner kind                     | Implementation                                      | Registered cases |
| ------------------------------- | --------------------------------------------------- | ---------------: |
| `http-endpoint`                 | direct                                              |                1 |
| `formula-table`                 | `field-add-lifecycle`                               |                3 |
| `conditional-lookup`            | `field-add-lifecycle`                               |                1 |
| `conditional-rollup`            | `field-add-lifecycle`                               |                1 |
| `conditional-query`             | `field-add-lifecycle` + `record-mutation-lifecycle` |               31 |
| `link-computed-propagation`     | `record-mutation-lifecycle`                         |                4 |
| `computed-chain-mutation`       | `record-mutation-lifecycle`                         |                8 |
| `customer-upsert-computed-flow` | `record-mutation-lifecycle`                         |                7 |
| `lookup-search-index`           | `read-lifecycle`                                    |                4 |
| `field-create`                  | `field-add-lifecycle`                               |                4 |
| `field-convert`                 | `field-convert-lifecycle`                           |                2 |
| `field-convert-link`            | `field-convert-lifecycle`                           |                2 |
| `field-update`                  | `record-mutation-lifecycle`                         |                1 |
| `field-delete`                  | `field-delete-lifecycle`                            |                1 |
| `field-restore`                 | direct                                              |                3 |
| `field-duplicate`               | `field-add-lifecycle`                               |                1 |
| `duplicate-table`               | `duplicate-lifecycle`                               |                3 |
| `duplicate-view`                | direct                                              |                1 |
| `duplicate-base`                | `duplicate-lifecycle`                               |                3 |
| `import-base`                   | direct                                              |                4 |
| `record-delete-link`            | `table-link-lifecycle`                              |                1 |
| `table-create`                  | `table-create-lifecycle`                            |                3 |
| `table-delete`                  | `table-lifecycle`                                   |                1 |
| `table-delete-link`             | `table-link-lifecycle`                              |                2 |
| `table-restore`                 | `table-lifecycle`                                   |                1 |
| `table-restore-link`            | `table-link-lifecycle`                              |                1 |
| `csv-import`                    | `csv-import-lifecycle`                              |                3 |
| `form-submit`                   | `record-mutation-lifecycle`                         |                1 |
| `record-paste`                  | `record-mutation-lifecycle`                         |                4 |
| `record-read`                   | `read-lifecycle`                                    |                3 |
| `record-create`                 | `record-mutation-lifecycle`                         |                1 |
| `record-update`                 | `record-mutation-lifecycle`                         |                1 |
| `record-update-attachment`      | `record-mutation-lifecycle`                         |                2 |
| `record-update-link`            | `record-mutation-lifecycle`                         |                1 |
| `record-reorder`                | `record-mutation-lifecycle`                         |                1 |
| `record-delete`                 | `record-replay-lifecycle`                           |                1 |
| `record-delete-stream`          | `record-mutation-lifecycle`                         |                3 |
| `record-undo`                   | `record-replay-lifecycle`                           |                1 |
| `record-redo`                   | `record-replay-lifecycle`                           |                1 |
| `selection-clear`               | `record-mutation-lifecycle`                         |                2 |
| `selection-duplicate`           | `record-duplicate-lifecycle`                        |                1 |
| `record-duplicate-single`       | `record-duplicate-lifecycle`                        |                1 |

<!-- END GENERATED RUNNER INVENTORY -->

## Direct implementations

Direct does not automatically mean backlog. It means the runner does not
currently cross a lifecycle-driver seam:

- `http-endpoint`: deliberately direct; its bare warmup and sampled GET loop
  shares no fixture or cleanup protocol with lifecycle runners.
- `field-restore`: remains direct until its restore-specific setup, trash lookup,
  stream operation, and verification have a clean second adapter or driver fit.
- `import-base`: remains direct because whole-base export/upload/import and
  cleanup do not fit the CSV import lifecycle.

## How migration proceeds

Incremental / boy-scout: when an agent next touches a runner, it moves that
runner onto a lifecycle driver only when the driver shape is clear. Each
migration must keep behavior identical, proven by the G1 artifact diff over its
cases × engines. The first driver becomes truly generic only after a second
family migrates. Update the canonical inventory entry when a runner moves, then
run `pnpm sync:readme` to refresh this projection.
