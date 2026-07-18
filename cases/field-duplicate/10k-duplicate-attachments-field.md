---
owner: backend-v2
tags:
  - field-duplicate
  - attachment
  - structured-value
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-attachments-field

## Goal

Measure duplicating one populated Attachment field and its 10,000 structured
values.

## Seed Phase

- Creates a table with primary `Title` and one Attachment field named
  `Attachments`.
- Inserts 10,000 deterministic rows in 1,000-row batches.
- Uploads one tiny text fixture through the public attachment endpoint, then
  uses its valid token to populate all rows outside the measured operation.
- Row `n` uses the deterministic display name
  `perf-attachment-<n>.txt`; no remote URL is fetched.
- Seed caching reuses the populated table and attachment metadata across V1/V2
  executions.

## Execute Phase

1. Restore or build the populated seed table.
2. Full-scan 10,000 rows and verify deterministic seed samples.
3. Duplicate `Attachments` to `Attachments Copy` through the public field
   endpoint.
4. Require the requested engine and canary feature `duplicateField`.
5. Verify the copied field metadata and full-scan all 10,000 source/copy pairs.
6. On a reusable local seed, delete only the copied field.

## Primary Metric

- `duplicateStructuredFieldMs`: synchronous field-duplicate request latency.
  Attachment upload, population, verification, and cleanup are excluded.

## Notes

The initial 20-second guardrail is intentionally uncalibrated and will be
replaced with a CI-derived bound before merge. Seed samples normalize attachment
objects to deterministic names; source/copy equality remains exact.
