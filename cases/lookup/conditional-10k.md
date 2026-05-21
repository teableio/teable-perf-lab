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

## Data Setup

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

## Operation

1. Create source table A and host table B.
2. Insert 10k deterministic rows into A.
3. Insert 10k deterministic rows into B.
4. Create conditional lookup field `Matched A Value` on B.
5. The lookup filters A rows where `A Key` equals B's `Lookup A Key`.
6. Full scan all 10k B rows and verify every lookup result.
7. Permanently delete both temporary tables.

## Primary Metric

- `conditionalLookupReadyMs`: conditional lookup field creation plus full
  readiness verification.

## Notes

This case is designed to stress the conditional lookup path with high-cardinality
row-specific matching. If it regresses, inspect the `createLookupField` and
`fullLookupScanReady` phases separately.
