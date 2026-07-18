---
owner: backend-v2
tags:
  - field-duplicate
  - user
  - structured-value
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-assignee-field

## Goal

Measure duplicating one populated User field and its 10,000 structured values.

## Seed Phase

- Creates a table with primary `Title` and one multiple-value User field named
  `Assignee`.
- Inserts 10,000 deterministic rows in 1,000-row batches.
- Every Assignee cell references the normal E2E seed identity
  `usrTestUserId`; no extra user is created.
- Seed caching reuses the ready table across V1/V2 executions.

## Execute Phase

1. Restore or build the populated seed table.
2. Full-scan 10,000 rows and verify deterministic seed samples.
3. Duplicate `Assignee` to `Assignee Copy` through the public field endpoint.
4. Require the requested engine and canary feature `duplicateField`.
5. Verify the copied field metadata and full-scan all 10,000 source/copy pairs.
6. On a reusable local seed, delete only the copied field.

## Primary Metric

- `duplicateStructuredFieldMs`: synchronous field-duplicate request latency.
  Seed, verification, and cleanup are excluded.

## Notes

The 8-second guardrail was calibrated from CI run `29647216759`, where the
primary metric was 3,559.85 ms on V1 and 358.78 ms on V2. User response objects
may be enriched, so seed samples normalize to ids; source/copy equality remains
exact.
