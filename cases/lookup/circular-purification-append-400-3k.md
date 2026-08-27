---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - circular
  - record-create
  - 3k
  - v1-v2
  - relationship
  - incident-regression
enabled: true
---

# lookup/circular-purification-append-400-3k

## Goal

Guard the **cost** of the burst-INSERT propagation shape from the
2026-08-27 CN production main-database incident (tsingke "抗体表达" base,
T7002 / teable-ee PR #3207) in the default **sync** computed-update mode:
400 new purification rows in four sequential 100-row batches, each wiring
all four link cells, must drive the full circular cross-table cascade and
have every newly linked host row readable in the tens of seconds (~13 s
measured at full scale). Growth in the burst-insert propagation path shows
up here as a threshold regression.

**Responsibility handoff (2026-08-27):** this shape also reproduces a
deterministic propagation **loss** under the production-default **hybrid**
strategy (batches race the previous batch's dispatched outbox task on the
per-table computed advisory lock; the loser fails with
`computed_update.lock_unavailable`, its propagation is silently dropped,
and `computed_update_outbox` ends up empty — the incident's forensic
fingerprint). That red-guard duty now lives in **teable-e2e-lab** case
`lookup/a-burst-of-new-rows-reaches-every-lookup` (e2e-lab PR #125,
ledger status `open`, issue **T7018**), whose verdict model expects the
failure while the bug is unfixed. This perf case was therefore taken OUT of
`HYBRID_COMPUTED_CASES` and runs in the V2 sync pool only — perf-lab CI
must not carry a permanently red case for a known unfixed bug.

The original reproduction record (2026-08-27, engine v2, full scale,
hybrid via `PERF_LAB_COMPUTED_UPDATE_MODE=hybrid`): deterministic across
commits — the run fails primary readiness after 600 s with a specific host
row stale (e.g. `SubOrder 1806 so_is_expressible expected YES-... actual
NO-...`), with 2-3 `computed:run:failed` `lock_unavailable` log entries and
an empty outbox, on BOTH `b913e5014` (pre-#3207) and `98f225c53` (the
#3207 fix): #3207's inline bounding does NOT close this loss path.

## Seed Phase

Identical four-table incident fixture as
`lookup/circular-dual-link-source-update-10of500-3k` (see its markdown for
the production fingerprint mapping): `plasmid` 3 rows, `orders` 6,000,
`sub-orders` 3,000 (85 fields, 24 computed), `purification` 500 (88 fields,
41 computed), circular SubOrders ⇄ Purification links with the duplicate
one-many pair, permutation-deterministic row mappings.

## Execute Phase

1. Verify seed samples (`seedReady`).
2. `POST /api/table/{purificationTableId}/record` — 400 NEW purification
   rows (p = 501..900, extending the same injective permutation so each
   appended row attaches to a distinct, previously purification-free
   sub-order) in FOUR sequential batches of 100 (`writeBatchSize`),
   mirroring the write-burst shape. Every row wires all four link cells
   (both duplicate backrefs + plasmid + order), so each batch triggers the
   full cross-table computed cascade.
3. The primary timer covers the POSTs plus polling ALL 400 newly linked host
   sub-orders through `getRecord` until each exposes the complete
   post-append lookup + formula state (7 purification lookups,
   `so_expression_card`, `so_is_expressible`, plus the phase-stable
   families). Polling waits for values, so asynchronous (outbox) convergence
   passes; silently dropped propagation does not.
4. After the timer stops, full paged scans of all 3,000 sub-orders and all
   900 purification rows prove the complete circular cascade, including the
   appended rows' own 41 computed fields.
5. Cleanup (local non-isolated runs only) deletes the 400 appended rows,
   re-verifies the seed samples, and drops all four tables if that fails.

## Primary Metric

- `circularPropagationReadyMs`: elapsed time from starting the first append
  batch until every newly linked host sub-order exposes its complete
  post-append computed state through the real read path.

`maxMs` is 120,000 ms — a provisional generous bound until the first CI
observation recalibrates it. Healthy V2 sync at full scale measured ~13.2 s
locally (`sourceUpdateMs` ~2.7 s for the four POSTs, `hostReadinessMs`
~10.5 s), so the provisional bound has ~9x headroom.

Diagnostics: `sourceUpdateMs`, `hostReadinessMs`, `cascadeVerificationMs`,
plus seed phases (`prepareMs`, `maxSeedBatchMs`, `seedReadyMs`).

## Verification

- Every POST batch must report exactly 100 records created (ids captured for
  cleanup).
- Primary readiness asserts the full computed state of each of the 400 hosts
  against locally computed expected values.
- The post-metric full scans assert every sub-order (appended hosts in
  linked state, the rest untouched) and all 900 purification rows.
- Routing headers from the POSTs are asserted against the requested engine
  (`createRecords` operation).

## Notes

Runner decision (reuse -> extend -> new): **extend**
`circular-link-propagation` with a third `mutation.kind`
(`"purification-append"`). The appended rows extend the existing purification
permutation, so the entire expected-value algebra is reused unchanged; the
runner additions are the shared row-payload builder (also used by seeding),
fixture-held order/plasmid record ids, phase-aware purification totals, and
create/delete write paths. A new runner would have duplicated the fixture
wholesale.

Failure-mechanism mapping for the hybrid-mode loss (kept as background for
local reproduction; the CI guard for it is the e2e-lab case above), from the
teable-ee sources, pre- and post-#3207:
`HybridWithOutboxStrategy` dispatches queued tasks ~50 ms after each write;
the dispatched execution runs with `lockWait: false` and the next insert
batch's inline run holds the exclusive per-table computed lock
(`v2:computed:{purificationTableId}`), so the dispatched run errors with
`computed_update.lock_unavailable` (`computed:run:failed` in logs) and its
steps are dropped without a pending outbox row surviving. Sequential batches
of 100 with 10-12 computed steps each reproduce this reliably at full scale.

Operational notes:

- In CI this case runs sync-mode only (it is deliberately absent from
  `HYBRID_COMPUTED_CASES`). To reproduce the hybrid loss locally, set
  `PERF_LAB_COMPUTED_UPDATE_MODE=hybrid`, which the harness maps to
  UNSETTING `V2_COMPUTED_UPDATE_MODE` (the app env schema only accepts
  `sync`; hybrid is the unset default — exporting the literal `hybrid`
  fails Joi validation at boot).
- A failed hybrid run can leave a locally cached seed fixture with stale
  host rows that later runs' deterministic values would mask; local seed
  caches touched by a failed hybrid run should be discarded (CI execute jobs
  run DB-isolated and are unaffected).
- For a fast local smoke, use `PERF_LAB_CLP_ORDER_ROWS` /
  `PERF_LAB_CLP_SUBORDER_ROWS` / `PERF_LAB_CLP_PURIFICATION_ROWS` /
  `PERF_LAB_CLP_MUTATION_ROWS`. Do not set `NEXT_BUILD_ENV_EDITION=CLOUD`
  for a full-scale local run (free-plan billing row limit rejects the seed).
