---
owner: backend-v2
tags:
  - field
  - delete
  - 10k
  - checkbox
  - v1-v2
enabled: true
---

# field-delete/10k-delete-active-field

## Goal

Measure deleting one populated checkbox field from a 10,000-row table and
isolate boolean/null storage deletion from other scalar field types.

## Seed Phase

- Create a table containing primary `Title` and checkbox field `Active`.
- Insert 10,000 deterministic alternating checkbox records in 1,000-row batches.
- Full-scan both fields and verify rows 1, 5,000, and 10,000 before execute.

## Execute Phase

1. Resolve `Active`, then start the primary timer.
2. Delete that one field through the public bulk field-delete endpoint.
3. Stop the timer after HTTP status and V1/V2 routing assertions pass.
4. Verify `Active` is absent, `Title` is the only field, and all 10,000
   deterministic titles remain readable.

## Primary Metric

- `deleteFieldMs`: synchronous deletion request latency for one populated
  checkbox field. Seed, id resolution, verification, and cleanup are excluded.

## Notes

The initial 10-second guardrail is an assumption to calibrate from official CI.
The route must report canary feature `deleteField` for the requested engine.
