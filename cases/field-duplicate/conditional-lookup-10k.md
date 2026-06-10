---
owner: backend-v2
tags:
  - field-duplicate
  - lookup
  - computed
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# field-duplicate/conditional-lookup-10k

## Goal

Measure duplicating the conditional lookup field from the
`lookup/conditional-10k` workload.

## Seed Phase

- Creates source table A with 10,000 rows.
- Creates host table B with 10,000 rows.
- A table fields:
  - `A Key`: `A-Key-<n>`
  - `A Value`: `A-Value-<n>`
- B table fields:
  - `B Key`: `B-Key-<n>`
  - `Lookup A Key`: a permuted `A-Key-<n>`
- The permutation uses multiplier `73` and offset `19`, so every B row maps to a
  unique A row and every lookup result is different.
- Creates conditional lookup field `Matched A Value` on B and waits for it to be
  ready across all 10,000 host rows.
- Seed hash inputs include the case id, `field-duplicate` runner kind, source
  and host field layout, `recordCount`, `batchSize`, permutation config,
  duplicate config, fixture version, and seed implementation code.

With seed caching enabled, both tables are named from the same `seedHash` and
reused across engines and workflow runs. The runner rebuilds them only on a
cache miss or failed seed validation.

## Execute Phase

1. Restore or build the two 10k-row seed tables.
2. Verify source and host samples are readable before field operations.
3. Verify cached conditional lookup field `Matched A Value` is ready.
4. Duplicate `Matched A Value` to `Matched A Value Copy` and record that request
   as the primary field operation.
5. Full scan all 10k B rows and verify every duplicated lookup result.
6. Clean up execute-only changes. On cached seeds, delete only the duplicated
   lookup field while preserving both seed tables and the source lookup field
   for the next run.

## Primary Metric

- `conditionalLookupDuplicateReadyMs`: duplicate-field request latency only.

## Notes

This case intentionally reuses the same deterministic source and host shape as
`lookup/conditional-10k`, but measures field duplication instead of initial
conditional lookup creation. The source lookup field is part of the reusable
seed; `createSourceLookupFieldMs` and `sourceLookupScanReadyMs` are seed
diagnostics and are not included in the primary metric. The runner still records
`duplicatedLookupScanReadyMs` as a post-operation correctness check, but it does
not contribute to the threshold metric.
