---
owner: backend-v2
tags:
  - lookup
  - computed
  - 10k
  - v1-v2
  - large-data
enabled: true
---

# lookup/conditional-10k

## Goal

Measure conditional lookup creation on two 10k-row tables where every host row
matches a different source row through a unique key.

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
- Seed hash inputs should include the case id, `conditional-lookup` runner kind,
  source/host field layout, `recordCount`, `batchSize`, permutation config,
  fixture version, and seed implementation code.

With seed caching enabled, both tables are named from the same `seedHash` and
reused across engines and workflow runs. The runner rebuilds them only on a
cache miss or failed seed validation.

## Execute Phase

1. Restore or build the two 10k-row seed tables.
2. Verify source and host samples are readable before measuring lookup work.
3. Create conditional lookup field `Matched A Value` on B.
4. The lookup filters A rows where `A Key` equals B's `Lookup A Key`.
5. Full scan all 10k B rows and verify every lookup result.
6. Clean up execute-only changes. On cached seeds, delete only the conditional
   lookup field on B and preserve both seed tables for the next run.

## Primary Metric

- `conditionalLookupReadyMs`: conditional lookup field creation plus full
  readiness verification.

## Notes

This case is designed to stress the conditional lookup path with high-cardinality
row-specific matching. If it regresses, inspect the `createLookupField` and
`fullLookupScanReady` phases separately.
