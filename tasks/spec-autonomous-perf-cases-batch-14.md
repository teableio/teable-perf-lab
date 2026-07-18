# Autonomous Perf Cases — Batch 14

Status: approved by standing user authorization on 2026-07-18. The user asked
the agent to choose complete batch boundaries, self-review each batch, verify it
locally and in CI, merge successful work, and continue from a fresh branch.

## Batch Goal

Add an independently diagnosable populated-field matrix for the product action
"duplicate this field with its values." The existing
`field-duplicate/conditional-lookup-10k` case protects one computed-field path,
but it does not reveal regressions in the SQL/storage representations used by
ordinary scalar and select fields.

This batch contains eight cases because that is the complete set of populated
non-primary scalar/select field types supported by the deterministic
record-replay generator: single-line text, long text, number, date, checkbox,
single select, multiple select, and rating. Each case uses a controlled narrow
table with `Title` plus one source field and duplicates the source across 10,000
populated rows.

Extend the existing `field-duplicate` runner with a scalar mode and keep it on
the existing `field-add-lifecycle`. The operation and restore semantics are the
same as the conditional-lookup member: prepare a populated seed, add one field,
verify it, then delete the added field from a reusable seed. Keep the existing
conditional-lookup config and artifact contract backward compatible.

The primary timer wraps only the public duplicate-field request, including the
synchronous value copy performed by that endpoint. Seed setup, the pre-operation
10,000-row readiness scan, field-id resolution, the post-operation metadata and
value scans, and cleanup stay outside the metric. Every request must route
through canary feature `duplicateField` on the requested V1 or V2 engine.

All cases initially use `duplicateScalarFieldMs` with `maxMs: 10_000`. This is
an explicit uncalibrated assumption; the first official V1/V2 CI run will be
used to set the committed guardrail before merge.

## Cases

1. `field-duplicate/10k-duplicate-owner-text-field`: duplicate one populated
   single-line text field.
2. `field-duplicate/10k-duplicate-description-field`: duplicate one populated
   long-text field.
3. `field-duplicate/10k-duplicate-amount-field`: duplicate one populated number
   field.
4. `field-duplicate/10k-duplicate-start-date-field`: duplicate one populated
   date field.
5. `field-duplicate/10k-duplicate-active-field`: duplicate one populated
   checkbox field.
6. `field-duplicate/10k-duplicate-status-field`: duplicate one populated
   single-select field with three deterministic choices.
7. `field-duplicate/10k-duplicate-tags-field`: duplicate one populated
   multiple-select field with four deterministic choices.
8. `field-duplicate/10k-duplicate-score-field`: duplicate one populated
   five-star rating field.

## Shared Contract

- **Runner**: extend `field-duplicate`; reuse `field-add-lifecycle` and the
  deterministic record-replay seed helper.
- **Seed phase**: create a 10,000-row table containing primary `Title` and
  exactly one populated source field; insert in 1,000-row batches.
- **Execute phase**: resolve the source field id, send one measured
  duplicate-field request with an explicit copy name, then verify outside the
  timer.
- **Primary metric**: `duplicateScalarFieldMs`, initial `maxMs: 10_000`, to be
  calibrated from official CI evidence before merge.
- **Routing**: require the requested V1/V2 engine and
  `x-teable-v2-feature: duplicateField`.
- **Metadata verification**: the new field has the requested name and the same
  field type as the source; exactly `Title`, source, and copy are present.
- **Value verification**: full-scan all 10,000 rows through the normal records
  API and prove every copied value exactly matches its source. Separately prove
  deterministic expected source values at offsets 0, 4,999, and 9,999.
- **Cleanup**: on reusable seeds, delete only the copied field; on ordinary
  local runs, permanently delete the scratch table; isolated CI execute
  databases may discard their mutated copies.

## Open Assumptions

- Ten thousand populated rows are large enough to expose value-copy regressions
  while keeping eight V1/V2 pairs practical in one workflow run.
- A narrow two-field seed is the correct controlled comparison: table width is
  constant and only the copied storage type changes.
- The duplicate endpoint is synchronous for these scalar/select types, so the
  request latency is the honest user-facing operation metric. The following
  full scan is a correctness assertion, not an asynchronous readiness wait.
- Comparing source and copy values through the public records API is the stable
  cross-engine contract; internal column types or SQL statements are not.
- The first official CI run is authoritative for threshold calibration; local
  timing is directional only.

## Explicit Rejections

- Do not add two synthetic cases merely to reach ten. Eight is the complete
  scalar/select series supported by the shared deterministic generator.
- Do not include user or attachment fields. Their values depend on external
  identities or assets and deserve an independently seeded batch.
- Do not include formula, lookup, rollup, conditional rollup, link, or other
  dependency-bearing fields. Their duplicate cost and readiness semantics are
  graph-shaped rather than scalar and need separate series.
- Do not duplicate the primary `Title` field; keeping a stable primary column
  makes every case comparable and preserves the post-operation read path.
- Do not include seed readiness, field-id resolution, verification scans, or
  cleanup in `duplicateScalarFieldMs`.
- Do not accept response metadata or routing headers alone; all 10,000 copied
  values must be read back and compared with the source values.
