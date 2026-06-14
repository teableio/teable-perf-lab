---
owner: backend-v2
tags:
  - form-submit
  - form
  - openapi
  - sequential
  - 200
  - mixed-fields
  - v1-v2
enabled: true
---

# form-submit/sequential-200

## Goal

Catch regressions in the public form-submission path by submitting 200 records
through a Form view one request at a time and measuring per-submit p95 latency.

## Seed Phase

- Creates one temporary empty table in the e2e seed base.
- The table has 20 user-input fields:
  - single line text: `Title`, `Owner Text`, `External ID`, `Source`
  - long text: `Description`, `Notes`, `Comment`
  - single select: `Status`, `Priority`, `Category`
  - multiple select: `Tags`, `Labels`
  - number: `Amount`, `Quantity`, `Percent`
  - date: `Start Date`, `Due Date`
  - checkbox: `Active`, `Approved`
  - rating: `Score`
- Creates a Form view over the table and resolves all field IDs.
- The seed is rebuilt fresh during execute. The submitted records are the
  measured workload and are not cached.

## Execute Phase

1. Start the per-submit timing loop after the empty table and Form view are
   ready.
2. Submit 200 deterministic records sequentially through
   `POST /api/table/{tableId}/record/form-submit`.
3. Send `{ viewId, fields, typecast: true }`, using field IDs in `fields`.
4. Assert the first and last response route through the requested engine with
   canary feature `formSubmit`; `routeMatched` (engine **and** feature) must
   hold or the case fails.
5. Verify each response carries the submitted deterministic values.
6. Full scan the grid view with `getRecords` and assert all 200 stored records
   match the generator.
7. Cleanup permanently deletes the temporary table on non-isolated local runs.

## Primary Metric

- `formSubmitP95Ms`: p95 over the 200 sequential form-submit requests.

The timer starts after table creation, field resolution, and Form view creation.
It includes only the individual submit requests and response value checks. Full
scan verification and cleanup are recorded separately.

## Notes

The initial `maxMs` guardrail is 4,000 ms per submit. The row count, p95
aggregation, and Form view field shape should be tightened after real CI
history exists for both engines.
