# Autonomous Perf Cases — Batch 13

Status: approved by standing user authorization on 2026-07-18. The user asked
the agent to choose each batch boundary, complete local and CI verification,
merge successful batches, and continue from a fresh branch without waiting for
per-case confirmation.

## Batch Goal

Turn the existing aggregate
`field-delete/mixed-10k-delete-19-fields` signal into an independently
diagnosable populated scalar-field matrix. The aggregate case protects the
bulk endpoint but cannot identify whether a regression comes from the deleted
column's storage or snapshot representation.

This batch contains eight cases because that is the complete set of populated
non-primary scalar/select field types already supported by the deterministic
record-replay generator: single-line text, long text, number, date, checkbox,
single select, multiple select, and rating. Each case uses a narrow two-field
fixture (`Title` plus the target field), deletes exactly the target field in one
measured request, and leaves only the populated primary field for verification.

Reuse the existing `field-delete` runner and `field-delete-lifecycle`. Extend
only the threshold metric type so single-field cases can report
`deleteFieldMs`; preserve the existing `delete19FieldsMs` artifact and case id.
No new runner or lifecycle driver is needed.

The primary timer wraps only the synchronous public field-delete request.
Fixture preparation, the pre-operation 10,000-row readiness scan, field-id
resolution, the post-operation metadata/read scan, and cleanup remain outside
the metric. Every request must route through canary feature `deleteField` on
the requested V1 or V2 engine.

All cases initially use `deleteFieldMs` with `maxMs: 10_000`. This is an
assumption pending the first official V1/V2 artifacts. It is intentionally
below the aggregate case's 20-second guardrail while remaining above that
case's historical 7.8-second worst; calibrate only after real CI measurements.

## Cases

1. `field-delete/10k-delete-owner-text-field`: delete one populated
   single-line text field.
2. `field-delete/10k-delete-description-field`: delete one populated long-text
   field.
3. `field-delete/10k-delete-amount-field`: delete one populated number field.
4. `field-delete/10k-delete-start-date-field`: delete one populated UTC date
   field.
5. `field-delete/10k-delete-active-field`: delete one populated checkbox
   field.
6. `field-delete/10k-delete-status-field`: delete one populated single-select
   field with three deterministic choices.
7. `field-delete/10k-delete-tags-field`: delete one populated multiple-select
   field with four deterministic choices.
8. `field-delete/10k-delete-score-field`: delete one populated five-star rating
   field.

## Shared Contract

- **Runner**: reuse `field-delete` through `field-delete-lifecycle`.
- **Seed phase**: create a deterministic 10,000-row table containing primary
  `Title` and exactly one populated target field; insert in 1,000-row batches.
- **Execute phase**: resolve the target field id, send one measured bulk-delete
  endpoint request containing that single id, then verify outside the timer.
- **Primary metric**: `deleteFieldMs`, initial `maxMs: 10_000`.
- **Routing**: require the requested V1/V2 engine and
  `x-teable-v2-feature: deleteField`.
- **Metadata verification**: the target field is absent and `Title` is the only
  remaining field.
- **Value verification**: full-scan all 10,000 records through the normal record
  API and prove every surviving `Title` remains deterministic; retain samples
  at row offsets 0, 4,999, and 9,999.
- **Cleanup**: destructive local runs permanently delete their scratch table;
  isolated CI execute databases may discard the mutated copy.

## Open Assumptions

- Ten thousand populated rows are large enough to exercise V1's value snapshot
  path and V2's physical column-delete path without duplicating the aggregate
  20-field workload.
- A narrow two-field fixture is the correct controlled comparison: table width
  is fixed while only the target field type changes.
- The first official CI run is authoritative for threshold calibration; local
  timings are direction-finding only.

## Explicit Rejections

- Do not add two synthetic cases merely to reach ten. The eight-case boundary
  is the complete scalar/select type series.
- Do not delete the primary `Title` field; the product forbids that operation
  and it would remove the post-delete value-verification path.
- Do not add computed, lookup, rollup, link, user, attachment, or button fields
  to this scalar batch. They require dependency or external-value setup and
  deserve separate operation-shaped series.
- Do not reuse one destructive fixture across sibling cases. Each schema is
  intentionally distinct, and isolated per-case seeds prevent one deletion
  from invalidating another case's source table.
- Do not include seed readiness, field-id resolution, verification, or cleanup
  in `deleteFieldMs`.
- Do not accept HTTP 200 or routing headers alone; field metadata and all 10,000
  surviving row values must be read back successfully.
