---
owner: backend-v2
tags:
  - field-update
  - single-select
  - formula
  - computed
  - cascade
  - 10k
  - v2-only
enabled: true
---

# field-update/v2-only-10k-select-option-rename-computed-cascade

## Goal

Catch regressions in the V2 field update path when renaming a populated
single-select option forces dependent computed fields to recalculate across a
10,000-row table. V2-only diagnostic: legacy updateField cannot express select
option rename, so V1 returns a skipped artifact and the case never enters
V1/V2 comparison.

## Seed Phase

- Creates one temporary table in the e2e seed base with `Title`
  (singleLineText) and `Status` (singleSelect).
- `Status` has four deterministic options: `Todo`, `Doing`, `Done`, and
  `Blocked`. The runner preserves the generated option ids and assigns row `n`
  to `options[(n - 1) % 4]`.
- Inserts 10,000 deterministic records in 1,000-record batches.
- Adds three computed fields in a dependency chain:
  `Status Mark = {Status} & "-mark"`, `Status Score` maps the mark to a
  numeric score, and `Status Bucket` maps that score to a text bucket.
- With seed caching enabled, the table is named from `seedHash` and the seed
  job waits for computed samples and a full 10,000-row scan before dumping the
  seed database.

## Execute Phase

1. Verify the restored seed table (`seedReady`) before starting the measured
   timer.
2. Execute the V2 `UpdateFieldCommand` contract handler
   (`executeUpdateFieldEndpoint`, contract path `/tables/updateField`)
   **in-process** — the nestjs backend does not mount this v2 oRPC route over
   HTTP — preserving every select option id while renaming only `Done` to
   `Closed`. This must produce `UpdateSingleSelectOptionsSpec.renamedOptions()`
   so `FieldValueChangeCollectorVisitor` marks `valueChangedFieldIds`.
3. Poll sample rows (offsets 0 / 2 / 4,998 / 9,998 — the unchanged `Todo`
   control row plus the first, middle, and last renamed `Done` rows) until the
   renamed option and dependent computed fields reflect the new values.
4. Full scan all 10,000 rows (1,000 per page) and verify every row's `Status`,
   `Status Mark`, `Status Score`, and `Status Bucket`.
5. Cleanup: on CI isolated execute databases the mutated seed copy is
   discarded with the database; local non-isolated runs delete the mutated
   table so a later run cannot reuse a dirty seed.

## Primary Metric

- `updateSelectOptionRenameCascadeReadyMs`: the updateField request plus
  computed readiness.

The metric starts after `seedReady` passes and covers the V2 updateField
request, sample polling, and the paged full scan. Table creation, record
seeding, initial computed field readiness, seed validation, and cleanup stay
out of it and are reported as diagnostics (`createTableMs`, `seedRecordsMs`,
`maxSeedBatchMs`, `seedComputedFieldsReadyMs`, `seedReadyMs`,
`updateFieldRequestMs`, `computedSamplesReadyMs`,
`computedFullScanReadyMs`, and seed cache metrics).

## Notes

This is a V2-only diagnostic case. The legacy
`PATCH /api/table/{tableId}/field/{fieldId}` route has `updateField`
canary routing, but its request schema only supports metadata updates such as
name, description, and db field name. It cannot express select option rename,
so non-V2 engines return a skipped artifact with the explicit reason instead
of running a different workload. It does not participate in V1/V2 comparison.

Because the measured operation is an in-process contract invocation, not an
HTTP request:

- `updateFieldRequestMs` excludes HTTP routing, auth, and serialization
  overhead, and there are no `x-teable-v2*` routing headers to assert; the
  artifact records `details.endpoint` (`invocation: in-process`,
  `httpMounted: false`) instead.
- The primary step's trace ref comes from a perf-lab OTel span wrapping the
  command-bus execution (the v2 tracer parents its spans on the active OTel
  context), so there is no HTTP server span in that trace.
- The call bypasses the `FieldOpenApiV2Service` wrapper, so its extras (audit
  context, field data-loader invalidation) do not run. Verification reads
  proved correct values regardless, but keep this difference in mind when
  comparing against product behavior.

`maxMs` (4,000) is calibrated 2026-06-22 from CI history (68 v2 runs; p95 ~1.6s,
worst ~1.8s), set to ~2x the worst observed so a real ~2x regression trips it
without flaking on CI variance.
