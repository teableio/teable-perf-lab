---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - circular
  - conditional
  - 3k
  - v1-v2
  - relationship
  - incident-regression
enabled: true
---

# lookup/circular-conditional-source-update-1of3-3k

## Goal

Guard the conditional-lookup fanout of the 2026-08-27 CN incident fixture: a
single-cell edit on the 3-row conditional-lookup source table (Plasmid) whose
dirty closure covers a third of BOTH host tables at once. This is the
maximum-fanout edit the incident base's shape allows from one cell, and it is
the plan family (`conditionalFiltered` propagation over a host-field filter)
that T7002 / teable-ee PR #3207 ("bound inline computed updates") routes away
from the user transaction when it degrades to a whole-table plan. The case
pins the cost of that closure so growth in the conditional target-scan path
shows up as a threshold regression.

Empirical note (2026-08-27, local): at this scale the closure is only two
step levels deep (`clu_pl_total` on ~1,000 SubOrders + `lu_pl_total` on ~167
Purification rows; the circular expression chain is not part of this edit's
closure), and both pre-fix (`b913e5014`) and post-fix (`98f225c53`) engines
complete it inline in well under a second. The case is therefore a fanout
cost guardrail, not a reproducer of the incident storm — the reproducer is
`lookup/circular-purification-append-400-3k`.

## Seed Phase

Identical four-table incident fixture as
`lookup/circular-dual-link-source-update-10of500-3k` (same row counts, field
families, circular SubOrders ⇄ Purification links, duplicate one-many link
pair, permutation mappings — see its markdown for the fingerprint mapping):
`plasmid` 3 rows, `orders` 6,000, `sub-orders` 3,000, `purification` 500. The
load-bearing elements here are:

- SubOrders' 3 **conditional lookups** against Plasmid filtered on
  `type_key` = host `plasmid_type_key` (production 条件 lookup → 质粒库).
  Every plasmid row is referenced by a third of all 3,000 sub-orders.
- Purification's 8 plain lookups over its plasmid link (a third of all 500
  purifications per plasmid row).

## Execute Phase

1. Verify seed samples (`seedReady`).
2. `PATCH /api/table/{plasmidTableId}/record` — ONE record: plasmid row 1's
   `total_amount_mg` (`100` -> `5100`), dirtying `clu_pl_total` on ~1,000
   SubOrders and `lu_pl_total` on ~167 Purification rows.
3. The primary timer covers the PATCH plus polling an evenly spaced sample of
   20 affected sub-orders (`verify.readinessSampleLimit`) through `getRecord`
   until each exposes the complete post-update lookup + formula state. The
   sampled readiness (instead of all ~1,000 rows) keeps the poll cheap and is
   deliberately compatible with asynchronous (outbox) convergence: it waits
   for values, not for a synchronous response contract.
4. After the timer stops, full paged scans of all 3,000 sub-orders and 500
   purifications prove the complete cascade (updated `clu_pl_total` /
   `lu_pl_total` everywhere row 1 is referenced, everything else in seed
   state).
5. Cleanup (local non-isolated runs only) restores the seed value and
   re-verifies, else drops all four tables.

## Primary Metric

- `circularPropagationReadyMs`: elapsed time from starting the plasmid PATCH
  until the sampled affected sub-orders expose their post-update computed
  state through the real read path.

`maxMs` is 120,000 ms — a coarse first-run guardrail. Local full-scale V2
runs measured ~0.76 s (sync inline), so the bound only trips when the
conditional fanout path degrades by orders of magnitude (e.g. whole-table
target scans re-entering the user transaction). Tighten once CI history
exists.

Diagnostics: `sourceUpdateMs`, `hostReadinessMs`, `cascadeVerificationMs`,
plus seed phases (`prepareMs`, `maxSeedBatchMs`, `seedReadyMs`).

## Verification

- The PATCH must report 1 record updated.
- Primary readiness asserts all 6 order lookups, 3 conditional plasmid
  lookups, 7 purification lookups, and 8 formulas on each sampled affected
  sub-order against locally computed expected values (with `clu_pl_total`
  reflecting the updated plasmid total).
- The post-metric full scans assert every sub-order and purification row,
  including the unaffected plasmid rows' hosts remaining in seed state.

## Notes

Runner decision (reuse -> extend -> new): **extend** `circular-link-propagation`
with a `mutation.kind` (`"plasmid-total"`), fixture-held plasmid record ids, and
`verify.readinessSampleLimit`. The fixture, expected-value algebra, and
lifecycle are shared with the sibling case; only the measured edit target and
the readiness sampling differ, so a new runner would have duplicated the
entire fixture (runners.md prefers extension when the contract is preserved).

Plan-shape mapping (from the ComputedUpdatePlanner sources): the conditional
lookup filter compares a Plasmid field against a host field reference, so the
filter fields are not all in the conditional table and the edge requires
old-match tracking; with a usable before image it stays `conditionalFiltered`
(precise host join per generation), without one it becomes `allTargetRecords`
(`conditional_filter_fields_not_in_source`) — the exact family #3207 defers
to the outbox before dirty-state preparation.

Local verification (2026-08-27, full 6k/3k/500/3 scale, single-database run,
engine v2, teable-ee `b913e5014` = pre-#3207): PASS with
`circularPropagationReadyMs` ≈ 763 ms (`sourceUpdateMs` 235 ms,
`hostReadinessMs` 528 ms), complete full-scan evidence and
`routeMatched: true`. For a fast local smoke, use `PERF_LAB_CLP_ORDER_ROWS` /
`PERF_LAB_CLP_SUBORDER_ROWS` / `PERF_LAB_CLP_PURIFICATION_ROWS` /
`PERF_LAB_CLP_MUTATION_ROWS`. Do not set `NEXT_BUILD_ENV_EDITION=CLOUD` for a
full-scale local run (free-plan billing row limit rejects the seed).
