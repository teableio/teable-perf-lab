# Autonomous Perf Cases — Batch 15

Status: approved by standing user authorization on 2026-07-18. The user asked
the agent to choose complete batch boundaries, self-review each batch, verify it
locally and in CI, merge successful work, and continue from a fresh branch.

## Batch Goal

Complete the populated stored-field duplicate matrix with the two structured
cell families that were intentionally left out of Batch 14: User and
Attachment. These are the only ordinary stored field types beyond the eight
scalar/select cases already protected. Their JSON-array payloads exercise a
different copy and serialization path from text, numeric, date, boolean, and
select storage.

The V2 duplicate-field E2E case matrix enumerates both User and Attachment
value-copy behavior, but those two value checks remain TODO. This batch turns
that intended contract into executable 10,000-row proof. User cells reference
the existing seeded E2E user. The Attachment case uploads one tiny deterministic
fixture through the public endpoint so every cell uses a valid token; no remote
URL or customer asset is involved.

Extend the stored-value mode of the existing `field-duplicate` runner rather
than adding another runner. The primary timer wraps only the public
duplicate-field request. Fixture creation, the pre-operation 10,000-row scan,
field-id resolution, post-operation metadata/value scans, and cleanup remain
outside the metric. Every request must route through canary feature
`duplicateField` on the requested V1 or V2 engine.

Both cases use `duplicateStructuredFieldMs` with `maxMs: 8_000`. The initial
20-second assumption was calibrated from official V1/V2 CI run `29647216759`:
the four measured values ranged from 335.44 to 3,559.85 ms, so the committed
guardrail leaves about 2.25x headroom above the slowest result.

## Cases

1. `field-duplicate/10k-duplicate-assignee-field`: duplicate one populated User
   field whose 10,000 cells reference the seeded E2E user.
2. `field-duplicate/10k-duplicate-attachments-field`: duplicate one populated
   Attachment field whose 10,000 cells contain deterministic synthetic file
   metadata.

## Shared Contract

- **Runner**: extend the existing stored-value branch of `field-duplicate` and
  keep `field-add-lifecycle` as the lifecycle driver.
- **Seed phase**: create a narrow 10,000-row table with primary `Title` plus one
  populated structured source field; insert in 1,000-row batches.
- **User seed**: each cell contains the stable `usrTestUserId` identity supplied
  by the normal Teable E2E seed.
- **Attachment seed**: upload one tiny text fixture through the public API, then
  populate row `n` with its valid token and deterministic display name
  `perf-attachment-<n>.txt`.
- **Execute phase**: resolve the source field id, send one measured
  duplicate-field request with an explicit copy name, then verify outside the
  timer.
- **Primary metric**: `duplicateStructuredFieldMs`, `maxMs: 8_000`, calibrated
  from official CI run `29647216759`.
- **Routing**: require the requested V1/V2 engine and
  `x-teable-v2-feature: duplicateField`.
- **Metadata verification**: the copy has the requested name, preserves the
  source field type, is not primary, and leaves exactly `Title`, source, and
  copy in the table.
- **Value verification**: full-scan all 10,000 rows through the public records
  API and prove source and copy values are exactly equal. Separately verify the
  deterministic identity or attachment name at offsets 0, 4,999, and 9,999.
- **Cleanup**: delete only the copied field from reusable seeds; delete the
  scratch table in ordinary local runs; allow isolated CI execute databases to
  discard their mutated copies.

## Open Assumptions

- Ten thousand JSON-array cells are large enough to expose structured-value
  copy regressions without turning the two-case batch into an asset benchmark.
- The seeded E2E user id is stable in every supported local and CI environment.
- Attachment upload and 10,000-row population are seed preparation and stay
  outside the duplicate request metric. Duplication copies stored attachment
  metadata and does not read the file payload.
- Exact source/copy equality through the records API is the cross-engine
  product contract. Seed-sample verification may normalize enriched User and
  Attachment response objects down to their deterministic ids and names.
- Official CI is authoritative for threshold calibration; local timing is
  directional only.

## Explicit Rejections

- Do not add a third synthetic case merely to make the batch larger. User and
  Attachment are the complete remaining stored structured-value family.
- Do not include Link fields. Their four relationship cardinalities and
  one-way duplication semantics form a separate complete batch.
- Do not include Formula, Rollup, Conditional Rollup, Conditional Lookup,
  system-computed, or Button fields. Their values are recomputed rather than
  copied and need readiness-aware cases.
- Do not include ordinary Lookup in a shared V1/V2 batch: the current V2
  duplicate-field contract rejects it with `field.lookup_cannot_duplicate`.
- Do not fetch attachment URLs, use customer assets, or create extra users; the
  only upload is the tiny repository-controlled text fixture created in seed.
- Do not include seed, verification, or cleanup time in
  `duplicateStructuredFieldMs`.
- Do not accept response metadata alone; every copied structured cell must be
  compared with its source.
