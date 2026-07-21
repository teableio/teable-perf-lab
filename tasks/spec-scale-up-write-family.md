# Scale-Up Write Family

## Assumptions

- Each baseline remains unchanged and gets a 5k sibling.
- The only workload-scale change is records per measured request: 1,000 to 5,000.
- Mixed create siblings share the `mixed-5k-20fields` empty-table seed identity inside the record-create runner.
- Mixed update siblings share the `mixed-5k-20fields` populated seed identity inside the record-update runner and restore it between cases.
- Primary-only siblings use separate `primary-5k-1f` seeds because their table shape differs.
- Initial `maxMs` is 30,000 for all cases; this is a hang guard, not a target.

## Cases

- `record-create/5k-multiple-select-fields-bulk-create`: one 5,000-record create with the same projected fields as `record-create/1k-multiple-select-fields-bulk-create`.
- `record-create/5k-number-fields-bulk-create`: one 5,000-record create with the same projected fields as `record-create/1k-number-fields-bulk-create`.
- `record-create/5k-rating-field-bulk-create`: one 5,000-record create with the same projected fields as `record-create/1k-rating-field-bulk-create`.
- `record-create/5k-wide-table-title-only-bulk-create`: one 5,000-record create with the same projected fields as `record-create/1k-wide-table-title-only-bulk-create`.
- `record-create/5k-primary-text-only-bulk-create`: one 5,000-record primary-only create.
- `record-update/5k-number-fields-bulk-update`: one 5,000-record PATCH with the same projected fields as `record-update/1k-number-fields-bulk-update`.
- `record-update/5k-rating-field-bulk-update`: one 5,000-record PATCH with the same projected fields as `record-update/1k-rating-field-bulk-update`.
- `record-update/5k-wide-table-title-only-bulk-update`: one 5,000-record PATCH with the same projected fields as `record-update/1k-wide-table-title-only-bulk-update`.
- `record-update/5k-primary-text-only-bulk-update`: one 5,000-record primary-only PATCH.

## Acceptance

All cases must pass source checks and local V1/V2 execution. Artifacts must prove routing, 5,000 affected response ids, and deterministic final-state samples. Create cases also verify SQL row count and omitted fields; update cases verify omitted fields retain seed values.

## Local Acceptance

All nine siblings passed local V1/V2 execution. Each artifact reports matched
engine routing, 5,000 affected records, three deterministic final-state
samples, and one captured trace reference. Trace snapshots were not downloaded
because the local Jaeger URL was not configured; CI remains the official trace
snapshot surface.

| Case                                                  | V1 primary | V2 primary |
| ----------------------------------------------------- | ---------: | ---------: |
| `record-create/5k-multiple-select-fields-bulk-create` | 2378.53 ms | 1113.20 ms |
| `record-create/5k-number-fields-bulk-create`          | 2438.19 ms | 1133.22 ms |
| `record-create/5k-primary-text-only-bulk-create`      | 1150.30 ms |  471.85 ms |
| `record-create/5k-rating-field-bulk-create`           | 1794.86 ms | 1395.91 ms |
| `record-create/5k-wide-table-title-only-bulk-create`  | 1460.39 ms |  905.04 ms |
| `record-update/5k-number-fields-bulk-update`          |  970.32 ms | 1338.40 ms |
| `record-update/5k-primary-text-only-bulk-update`      |  814.69 ms |  913.73 ms |
| `record-update/5k-rating-field-bulk-update`           |  877.47 ms | 1477.49 ms |
| `record-update/5k-wide-table-title-only-bulk-update`  |  723.73 ms |  976.43 ms |
