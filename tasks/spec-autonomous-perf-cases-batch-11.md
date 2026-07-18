# Autonomous Perf Cases — Batch 11

Status: approved by standing user authorization on 2026-07-18. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and calibrate only if official artifacts show the existing sub-second
guardrail is inappropriate.

## Batch Goal

Add a scalar field-type matrix for public Form-view submissions. Existing
coverage has one mixed 20-field case that submits 200 records sequentially. It
protects the aggregate `formSubmit` path but cannot identify the field type
responsible for a regression. The new matrix holds the request count at 50 and
varies only the form schema.

Reuse the existing seedless `form-submit` runner and its
`record-mutation-lifecycle` seam. Before the primary loop, each case creates an
empty table, resolves field ids, and creates a Form view. The measured workload
is 50 sequential `POST /api/table/{tableId}/record/form-submit` requests with
`typecast: true`. Every response value is checked inside the loop; afterward,
the runner scans all 50 stored records and compares every submitted cell.

Fifty requests are enough to produce a meaningful p95 while keeping the batch
at 500 requests per engine instead of duplicating the established 200-request
workload ten times. Trace selection captures iterations 1, 25, and 50 for each
case. The first and last responses must route through canary feature
`formSubmit` on the requested engine.

The same scalar schema is now used by record-paste, record-duplicate, and
table-create families in near-duplicate helper files. This batch introduces a
runner-neutral scalar field matrix and migrates the newly added table-create
helper to it before form-submit adopts it. Do not change the field names,
options, ordering, or values of the existing table-create cases.

All cases initially use the established `formSubmitP95Ms` metric with
`maxMs: 2_000`. The existing 200-submit case has historical p95 around 253 ms
and worst around 273 ms; 2 seconds is the repository's intentional floor for a
noisy sub-second CI metric.

## Cases

1. `form-submit/sequential-50-primary-only`: one primary text field; narrowest
   public form-submit baseline.
2. `form-submit/sequential-50-single-line-text-10fields`: primary plus nine
   text fields; isolate plain text typecasting at fixed width.
3. `form-submit/sequential-50-long-text-10fields`: primary plus nine long-text
   fields; isolate long-text submissions.
4. `form-submit/sequential-50-number-10fields`: primary plus nine number fields;
   isolate numeric typecasting.
5. `form-submit/sequential-50-date-10fields`: primary plus nine UTC date fields;
   isolate date parsing and normalization.
6. `form-submit/sequential-50-checkbox-10fields`: primary plus nine checkbox
   fields; isolate alternating checked/empty form values.
7. `form-submit/sequential-50-single-select-10fields`: primary plus nine fields
   cycling three fixed choice names; isolate option resolution.
8. `form-submit/sequential-50-multiple-select-10fields`: primary plus nine
   fields carrying two-choice arrays; isolate multi-select typecasting.
9. `form-submit/sequential-50-rating-10fields`: primary plus nine five-star
   rating fields; isolate bounded rating values.
10. `form-submit/sequential-50-single-line-text-20fields`: primary plus nineteen
    text fields; expose payload-width scaling without mixed-type effects.

## Shared Contract

- **Runner**: `form-submit`.
- **Seed Phase**: skipped; every case builds a fresh scratch table and Form view
  during execute setup.
- **Execute Phase**: 50 sequential public form-submit requests with deterministic
  field-id keyed payloads and `typecast: true`.
- **Primary Metric**: `formSubmitP95Ms`, initial `maxMs: 2_000`.
- **Routing**: first and last responses must match the requested V1/V2 engine
  and `x-teable-v2-feature: formSubmit`.
- **Verification**: all 50 response bodies, full scan of all 50 stored rows,
  exact values in every configured field, and artifact samples for row offsets
  0, 24, and 49.
- **Trace selection**: submit iterations 1, 25, and 50, with the existing
  fallback sampling policy.
- **Cleanup**: permanently delete the scratch table on non-isolated local runs.

## Explicit Rejections

- Do not add ten 200-submit cases. That would send 2,000 sequential requests
  per engine and mostly repeat the existing mixed workload.
- Do not include table or Form-view creation in `formSubmitP95Ms`.
- Do not accept HTTP 201 or routing headers as correctness proof; response and
  stored values must both match.
- Do not add computed, link, attachment, user, or button fields. They need
  dependency setup or are not ordinary form inputs, so they would stop being a
  controlled scalar matrix.
- Do not create reusable seed fixtures; form submissions are the records this
  family is designed to create.
