---
owner: backend-v2
tags:
  - field
  - delete
  - 10k
  - date
  - v1-v2
enabled: true
---

# field-delete/10k-delete-start-date-field

## Goal

Measure deleting one populated UTC date field from a 10,000-row table and
isolate serialized date snapshot/drop cost from other scalar field types.

## Seed Phase

- Create a table containing primary `Title` and UTC date field `Start Date`.
- Insert 10,000 deterministic populated records in 1,000-row batches.
- Full-scan both fields and verify rows 1, 5,000, and 10,000 before execute.

## Execute Phase

1. Resolve `Start Date`, then start the primary timer.
2. Delete that one field through the public bulk field-delete endpoint.
3. Stop the timer after HTTP status and V1/V2 routing assertions pass.
4. Verify `Start Date` is absent, `Title` is the only field, and all 10,000
   deterministic titles remain readable.

## Primary Metric

- `deleteFieldMs`: synchronous deletion request latency for one populated date
  field. Seed, id resolution, verification, and cleanup are excluded.

## Notes

The 2-second guardrail was calibrated from CI run 29644543456, whose 16 V1/V2
artifacts ranged from 134.36 to 295.10 ms. The route must report canary feature
`deleteField` for the requested engine.
