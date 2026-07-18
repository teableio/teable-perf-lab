---
owner: backend-v2
tags:
  - field
  - delete
  - 10k
  - single-line-text
  - v1-v2
enabled: true
---

# field-delete/10k-delete-owner-text-field

## Goal

Measure deleting one populated single-line text field from a 10,000-row table,
so text-column regressions are distinguishable from the mixed 19-field bulk
delete case.

## Seed Phase

- Create a table containing primary `Title` and single-line text `Owner Text`.
- Insert 10,000 deterministic populated records in 1,000-row batches.
- Full-scan both fields and verify rows 1, 5,000, and 10,000 before execute.

## Execute Phase

1. Resolve `Owner Text`, then start the primary timer.
2. Delete that one field through the public bulk field-delete endpoint.
3. Stop the timer after HTTP status and V1/V2 routing assertions pass.
4. Verify `Owner Text` is absent, `Title` is the only field, and all 10,000
   deterministic titles remain readable.

## Primary Metric

- `deleteFieldMs`: synchronous deletion request latency for one populated text
  field. Seed, id resolution, verification, and cleanup are excluded.

## Notes

The initial 10-second guardrail is an assumption to calibrate from official CI.
The route must report canary feature `deleteField` for the requested engine.
