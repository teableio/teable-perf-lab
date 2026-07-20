---
owner: backend-v2
tags:
  - lookup
  - conditional
  - computed
  - record-create
  - dirty-scope
  - v2-only
enabled: true
---

# lookup/v2-only-conditional-dirty-host-create-100-10k

## Goal

Catch V2 sync regressions where creating a small set of records under an
existing field-reference conditional lookup recalculates every host row instead
of restricting the computation to the dirty records.

## Seed Phase

- Reuses the deterministic physical fixture shared with
  `lookup/conditional-10k` and `rollup/conditional-10k`.
- Creates source table A with 10,000 unique `A Key` / `A Value` rows.
- Creates host table B with 10,000 `B Key` / `Lookup A Key` rows.
- The host lookup keys use the same coprime permutation as the existing 10k
  conditional lookup case, so all seed lookup values are distinct and locally
  derivable.
- The conditional lookup field is deliberately not part of the cached seed.

## Execute Phase

1. Restore and verify the shared source/host fixture.
2. As unmeasured setup, create conditional lookup field
   `Matched A Value before dirty create` and full-scan all 10,000 existing host
   rows until the field is correct.
3. Start the primary timer and create 100 new host rows in one request. Their
   `B Key` values are `B-Key-10001` through `B-Key-10100`, and they reference
   source rows 1 through 100.
4. Wait until all 100 created rows expose the expected lookup values.
5. Full-scan the resulting 10,100 host rows, proving that all 10,000 controls
   remain correct and all 100 dirty rows converged.
6. Remove the created rows and execute-only lookup field before another case
   reuses the shared fixture. If exact restoration cannot be proven, delete the
   fixture so it is rebuilt instead of reused dirty.

## Primary Metric

- `conditionalLookupRecordCreateReadyMs`: one 100-record create request, dirty
  record lookup readiness, and the final 10,100-row verification scan.

Seed restore/build, lookup field creation, and the initial 10,000-row lookup
backfill are diagnostics outside the primary metric. They are reported as
`seedRestoreMs` / `seedBuildMs`, `createLookupFieldSetupMs`, and
`lookupSetupReadyMs`.

## Notes

This is V2 sync-only because it protects the V2 computed query-builder's dirty
host scope. V1 emits a skipped artifact instead of running a different query
path, and the case remains in the normal V2 sync pool rather than hybrid.

The migrated teable-ee scenario also created an unrelated 40-row order table.
That table did not feed the conditional lookup or any assertion, so this case
omits it and retains only the source, host, lookup, and dirty-record behavior
that can affect the measured path.
