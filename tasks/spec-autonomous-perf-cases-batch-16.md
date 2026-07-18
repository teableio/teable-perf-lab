# Autonomous Perf Cases — Batch 16

Status: approved by standing user authorization on 2026-07-18. The user asked
the agent to choose complete batch boundaries, self-review each batch, verify it
locally and in CI, merge successful work, and continue from a fresh branch.

## Batch Goal

Complete the populated Link field-duplicate relationship matrix with four
10,000-edge cases: `manyMany`, one-way `oneMany`, `manyOne`, and `oneOne`.
Together they cover both V2 SQL value-copy strategies and every corresponding
V1 path that is currently runnable:

- `manyMany` and one-way `oneMany` copy 10,000 junction-table rows.
- `manyOne` and `oneOne` copy 10,000 host-table foreign-key values.

Every case uses 10,000 host rows and 10,000 foreign rows. Host row `n` links to
foreign row `n`, so all four relationships carry exactly 10,000 deterministic
edges while satisfying the exclusivity rules of `oneMany` and `oneOne`.

Local matrix validation exposed a deterministic V1 product limitation for
`oneOne`: V1 derives the copy's unique-constraint name from the same truncated
table identifier as the source constraint, so PostgreSQL returns `42710
duplicate_object`. V2 completes the same workload. The `oneOne` case is
therefore explicitly V2-only and emits a V1 skipped artifact; the other three
cases remain V1/V2 comparisons.

Extend the existing `field-duplicate` runner with a dedicated Link adapter and
reuse the linked-table seed infrastructure. The primary timer wraps only the
public duplicate-field request. Table creation, record seeding, pre-operation
checks, post-operation scans, and cleanup stay outside the metric. Every request
must route through canary feature `duplicateField` on the requested supported
engine.

The first official CI run also exposed a seed-compatibility boundary for the
FK-backed variants. The shared seed is bootstrapped through V1, whose Link
metadata stores the physical host relation as `baseId.tableId`; V2 treats that
dotted value as one quoted relation name. Rebuilding only the Link field is not
sufficient because the host table keeps the legacy identity, and a V1-created
one-one constraint cannot be safely removed through V2. Therefore V2
`manyOne`/`oneOne` executions build a complete V2-native host/foreign table
pair in the unmeasured prepare phase and record the cache bypass in the result.
The junction-backed variants continue to reuse the shared V1 seed.

All four cases initially use `duplicateLinkFieldMs` with `maxMs: 180_000`.
This is an explicitly uncalibrated ceiling because V1 copies supported Link
values through 1,000-row record-update pages while V2 uses direct SQL. The
first official CI run will set the committed guardrail before merge.

## Cases

1. `field-duplicate/10k-duplicate-many-many-link-field`: duplicate a populated
   two-way `manyMany` source; the copy becomes one-way and retains all edges.
2. `field-duplicate/10k-duplicate-one-many-one-way-link-field`: duplicate a
   populated one-way `oneMany` source and retain all exclusive edges.
3. `field-duplicate/10k-duplicate-many-one-link-field`: duplicate a populated
   two-way `manyOne` source; the copy becomes one-way and retains all FKs.
4. `field-duplicate/v2-only-10k-duplicate-one-one-link-field`: on V2, duplicate
   a populated two-way `oneOne` source; the copy becomes one-way and retains all
   exclusive FKs. V1 returns a documented skip for its duplicate-constraint
   collision.

## Shared Contract

- **Runner**: add a Link-specific adapter behind the existing
  `field-duplicate` dispatch and keep `field-add-lifecycle` as the lifecycle
  driver.
- **Seed phase**: create a foreign table with 10,000 deterministic primary
  values, then a host table with primary `Title`, one Link field, 10,000 rows,
  and one valid edge per row. Insert in 1,000-row batches.
- **V2 FK seed boundary**: for `manyOne` and `oneOne`, bypass the shared V1
  cache during V2 execute and build the same deterministic fixture natively on
  V2. Keep that build inside `prepareMs`, outside `duplicateLinkFieldMs`, and
  emit `details.v2NativeFixture` so the compatibility boundary is visible.
- **Relationship shape**: create two-way sources for `manyMany`, `manyOne`, and
  `oneOne`; create the `oneMany` source one-way because that is its distinct
  junction-table duplicate path.
- **Execute phase**: resolve the source Link id, send one measured
  duplicate-field request with an explicit copy name, then verify outside the
  timer.
- **Primary metric**: `duplicateLinkFieldMs`, initial `maxMs: 180_000`, to be
  calibrated from official CI evidence before merge.
- **Routing**: require the requested supported engine and
  `x-teable-v2-feature: duplicateField`.
- **Host metadata verification**: source and copy have the requested
  relationship and foreign table; the copy has `isOneWay: true`, has no
  `symmetricFieldId`, is not primary, and leaves exactly `Title`, source, and
  copy on the host table.
- **Foreign metadata verification**: duplicating a two-way source must not add a
  second symmetric field to the foreign table. The complete foreign field-id set
  must remain unchanged.
- **Value verification**: full-scan all 10,000 host rows through the public
  records API. Every source and copy cell must contain the same single foreign
  record id. At offsets 0, 4,999, and 9,999, also prove the deterministic foreign
  title.
- **Cleanup**: delete only the copied field from reusable seeds; delete both
  scratch tables in ordinary local runs; allow isolated CI execute databases to
  discard their mutated copies.

## Open Assumptions

- Ten thousand edges are large enough to expose both junction-copy and FK-copy
  regressions without turning the cases into high-fanout graph benchmarks.
- A one-to-one row mapping is deliberately shared across relationships so the
  only meaningful workload difference is physical Link storage and constraint
  behavior.
- The product contract is that every duplicated Link becomes one-way, retains
  the source relationship and foreign table, copies record values, and creates
  no new symmetric field.
- Official CI is authoritative for threshold calibration; local timing is
  directional only.
- A V1 skip for `oneOne` is not a passing performance sample. It documents the
  unsupported product path while keeping the complete V2 relationship matrix
  runnable.
- A V2-native FK fixture is not a different workload: it keeps the same two
  10,000-row tables and exact row-to-row edge mapping. It only prevents legacy
  V1 physical-relation metadata from invalidating the V2 product path before
  the measured operation begins.

## Explicit Rejections

- Do not add two-way `oneMany` to this batch. Its value storage overlaps the FK
  copy branch, while the intended relationship matrix explicitly calls out the
  one-way `oneMany` junction variant.
- Do not mix multiple links per cell or high fanout into this batch. Those are
  separate scale dimensions and would make relationship comparisons ambiguous.
- Do not include cross-space Links. They deliberately downgrade to text and are
  a separate product contract.
- Do not include Lookup, Rollup, Conditional Lookup, or Conditional Rollup;
  their values are computed and need readiness-aware verification.
- Do not include seed, verification, or cleanup time in
  `duplicateLinkFieldMs`.
- Do not accept response metadata alone; all 10,000 copied Link values and the
  foreign-table field set must be verified.
