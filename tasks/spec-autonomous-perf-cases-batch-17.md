# Autonomous Perf Cases — Batch 17

Status: approved by standing user authorization on 2026-07-18. The user asked
the agent to choose complete batch boundaries, self-review each batch, verify it
locally and in CI, merge successful work, and continue from a fresh branch.

## Batch Goal

Complete the dependency-bearing computed-field duplicate family. The repository
already measures a 10,000-row Conditional Lookup duplicate, but Formula,
link-based Rollup, and Conditional Rollup are still missing. These three new
cases exercise distinct dependency shapes while keeping one common product
action: duplicate an already-ready computed field and wait until the duplicate
is correct across all 10,000 host rows.

The batch also corrects the existing
`field-duplicate/conditional-lookup-10k` primary metric boundary. Its metric is
named `conditionalLookupDuplicateReadyMs`, but currently records only the HTTP
request and excludes the following full readiness scan. Computed-field
duplication can return before every derived value is readable, so the regression
guard must cover the request plus readiness. Seed creation and source-field
readiness remain outside the primary metric.

Product source and E2E coverage confirm that Formula, Rollup, Conditional
Rollup, and Conditional Lookup are supported duplicate types on both V1 and V2.
Ordinary Lookup is intentionally excluded: the current V2 duplicate-field
contract declares `field.lookup_cannot_duplicate` for that shape. Together the
three new cases and the corrected existing case therefore form the complete
runnable dependency-bearing computed series.

All four members initially use a 120,000 ms end-to-end ceiling. This is an
explicitly uncalibrated safety bound; the first official CI run will establish
relationship-specific committed thresholds before merge.

## Cases

1. `field-duplicate/10k-duplicate-formula-field`: duplicate a ready arithmetic
   Formula over three deterministic numeric inputs.
2. `field-duplicate/10k-duplicate-rollup-field`: duplicate a ready Rollup over
   a populated 10,000-edge many-many Link, summing one deterministic foreign
   number per host row.
3. `field-duplicate/10k-duplicate-conditional-rollup-field`: duplicate a ready
   Conditional Rollup that uniquely matches every host row to one permuted
   foreign row.
4. Existing `field-duplicate/conditional-lookup-10k`: keep its fixture and id,
   but make `conditionalLookupDuplicateReadyMs` equal duplicate request time
   plus duplicated-field full-readiness time.

## Shared Contract

- **Runner**: extend `field-duplicate` with a computed adapter and keep
  `field-add-lifecycle` as the lifecycle driver. Reuse existing conditional
  source/host helpers where their fixture is identical; keep formula and
  link-rollup fixture construction inside the adapter rather than distorting an
  unrelated runner kind.
- **Seed boundary**: build deterministic source fields and wait until all source
  computed values are ready before the primary timer begins. Source fields are
  part of reusable seeds; execute creates only the duplicate.
- **Formula fixture**: one 10,000-row host table with primary `Title`, numeric
  inputs `A`, `B`, `C`, and source Formula `Total = ({A} * {B}) + {C}`. Values
  are derived from the row number and are distinct.
- **Rollup fixture**: one 10,000-row foreign table with primary `Key` and numeric
  `Amount`, plus one 10,000-row host table whose many-many Link maps host row
  `n` to foreign row `n`. Source Rollup `Amount Sum` uses `sum({values})`, so
  host row `n` resolves to its deterministic foreign amount.
- **Conditional Rollup fixture**: reuse the unique-key permutation from
  `rollup/conditional-10k`; source field `Joined A Value` evaluates
  `array_join({values})` with limit 1.
- **Conditional Lookup fixture**: preserve the existing 10,000-row unique-key
  permutation and source field contract.
- **Execute phase**: after source readiness proof, start one primary
  measurement, send one public duplicate-field request, assert the requested
  engine and `x-teable-v2-feature: duplicateField`, then poll/read until the
  duplicated field passes a complete 10,000-row scan.
- **Primary metric**: `computedFieldDuplicateReadyMs` for the three new cases;
  `conditionalLookupDuplicateReadyMs` for the existing case. Each equals
  duplicate request duration plus duplicated-field readiness duration. Initial
  `maxMs: 120_000`, calibrated from official CI before merge.
- **Diagnostic metrics**: separately retain duplicate request time and
  readiness-scan time so a regression can be assigned to schema creation or
  computed propagation.
- **Metadata verification**: the duplicate has the requested name, preserves
  type, expression, formatting/dependency configuration, is not primary, and
  does not create or mutate unrelated fields.
- **Value verification**: full-scan all 10,000 host rows through the public
  records API. Source and duplicate values must be identical on every row. At
  offsets 0, 4,999, and 9,999, also prove the locally derived expected value.
- **Failure evidence**: once the duplicate request completes, retain its timing,
  response/routing headers, partial scan progress, verified samples, and the
  final error even if readiness verification fails.
- **Cleanup**: delete only the duplicated field from reusable seeds; delete all
  scratch tables in ordinary local runs; allow isolated CI execute databases to
  discard their mutated copies.

## Open Assumptions

- Ten thousand rows and exactly one dependency result per host row isolate
  duplicate/recompute cost without mixing in high-fanout aggregation.
- The Rollup uses a many-many junction Link to avoid conflating this batch with
  FK-backed Link compatibility and to keep one deterministic edge per host.
- The same row count and sample offsets across all four members make readiness
  evidence comparable even though their dependency graphs differ.
- Request plus readiness is the user-visible performance contract for computed
  duplication; request-only latency is retained only as a diagnostic.
- Shared V1 seed fixtures are expected to be readable by the V2 execute path.
  If a product compatibility boundary appears locally or in CI, it must be made
  explicit in fixture preparation and artifacts rather than hidden by a retry.
- Official CI is authoritative for threshold calibration; local timing is
  directional only.

## Explicit Rejections

- Do not add ordinary Lookup. Its V2 contract currently rejects duplication,
  while Conditional Lookup is a distinct supported field type and already has
  a runnable case.
- Do not add system-computed fields (`Created Time`, `Last Modified Time`,
  `Created By`, `Last Modified By`, `Auto Number`) or Button. They form separate
  non-dependency-backed families and do not belong in this graph-shaped batch.
- Do not add multi-link fanout, multiple aggregation functions, or larger row
  counts. Those are separate scale dimensions after the one-edge 10k baseline.
- Do not include seed creation or source-field readiness in the primary metric.
- Do not treat response metadata or a few samples as readiness; every promised
  host row must be checked through the real read path.
