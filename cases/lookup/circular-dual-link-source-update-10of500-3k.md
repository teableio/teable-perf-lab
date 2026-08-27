---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - circular
  - 3k
  - v1-v2
  - relationship
  - incident-regression
enabled: true
---

# lookup/circular-dual-link-source-update-10of500-3k

## Goal

Catch regressions in upward computed propagation through a circular
cross-table link/lookup graph: editing a handful of scalar cells on a link
_child_ table must recompute only the affected host rows, not storm the whole
graph. This case freezes the 2026-08-27 CN production main-database incident
(tsingke customer, "抗体表达" base): two same-shape sync-path bulk UPDATEs each
ran ~25 minutes, ~160 sessions piled up blocked behind them, and postmaster
was ultimately OOM-killed and restarted. The trigger was editing one numeric
cell (表达量 mg/L) on the Purification table, which propagated up a one-many
link into SubOrders lookups and formulas and back down into Purification's
reverse lookups — all tables small, but the dependency graph circular and
doubled by a duplicate link.

## Seed Phase

Four tables mirroring the production fingerprint (semantic English names;
production mapping in parentheses):

- `plasmid` (质粒库-细胞接收): 3 rows, 16 fields. Conditional-lookup source
  with a unique `type_key` per row.
- `orders` (抗体订单): 6,000 rows, 34 fields (6 own-field formulas as its 6
  computed fields).
- `sub-orders` (抗体子订单, the incident UPDATE victim): 3,000 rows, 85
  fields. 4 links — many-one to `orders`, many-one to `plasmid`, and **two
  duplicate one-many links to `purification`** (production "表达-纯化" and
  "表达-纯化 (linked)"). Computed: 6 lookups over the order link, 7 lookups
  over the purification link — including `lu_p_actual_expression`, which pulls
  the Purification _formula_ `actual_expression` (production 实际表达量, the
  formula-over-lookup) — 3 conditional lookups filtered against `plasmid`
  (production 条件 lookup → 质粒库), and 8 formulas, among them
  `so_expression_card` over the cross-table purification lookup (production
  H1用量 / 是否可以表达 class of formulas; expressions are simplified to
  deterministic concatenation, dependency edges preserved).
- `purification` (表达-纯化, the edit source): 500 rows, 88 fields, 41
  computed: 14 formulas, **18 reverse lookups into `sub-orders`** (9 text /
  4 single-select / 4 number / 1 link) split across the two symmetric backref
  links so the duplicate link genuinely doubles the dependency edges, 8
  lookups into `plasmid`, and 1 lookup into `orders`. `lu_so_expression_card`
  targets the SubOrders formula and `p_chain_card` sits on top of it, closing
  the circle SubOrders ⇄ Purification.

Row mappings are permutation-deterministic (multipliers coprime with the row
counts), each purification attaches both duplicate backrefs to the same
distinct sub-order, and every cell value is computable from the row number.
With seed caching the four tables are named from `seedHash`, and the seeded
sub-order/purification record ids plus sibling table ids are persisted in the
sub-orders table description. `seedReady` revalidates sampled sub-orders
(linked and unlinked branches) and purifications.

## Execute Phase

1. Verify seed samples (`seedReady`).
2. `PATCH /api/table/{purificationTableId}/record` — one bulk request editing
   `expression_mg_l` on purification rows 1..10 (`p*10` -> `p*10 + 1000`).
3. The primary timer covers the PATCH plus polling the 10 affected sub-orders
   through `getRecord` until **every** lookup and formula on them reflects the
   new values (including the formula-over-lookup chain).
4. After the timer stops, a full paged scan of all 3,000 sub-orders and all
   500 purifications proves the complete circular cascade, including
   `p_chain_card` = formula over the reverse lookup of the changed SubOrders
   formula. Routing headers from the PATCH are asserted against the requested
   engine.
5. Cleanup (local non-isolated runs only) restores the seed expression values,
   re-verifies the samples, and drops all four tables if the restore fails.

## Primary Metric

- `circularPropagationReadyMs`: elapsed time from starting the bulk
  purification update until every affected sub-order exposes its complete
  post-update lookup + formula state through the real read path. This is the
  user-visible wait between the incident's cell edit and correct reads.

The initial `maxMs` is 120,000 ms — a coarse first-run guardrail chosen
without CI history (assumption). A healthy engine touches ~10 purifications
and ~10 sub-orders; the incident regression shape (whole-graph storm
recompute) either blows far past this bound or times out at the 600s
verification limit. Tighten once real V1/V2 baselines exist.

Diagnostics: `sourceUpdateMs` (the PATCH only), `hostReadinessMs` (poll window
after the response), `cascadeVerificationMs` (post-metric full circular scan),
plus seed phases (`prepareMs`, `maxSeedBatchMs`, `seedReadyMs`).

## Verification

- The PATCH must report all 10 records updated.
- Primary readiness reads each affected sub-order by record id and asserts all
  6 order lookups, 3 conditional plasmid lookups, 7 purification lookups, and
  8 formulas against locally computed expected values.
- The post-metric full scans assert every sub-order (updated rows in updated
  state, the rest in seed state; unlinked rows prove empty purification
  lookups) and every purification row, including the circle-closing
  `lu_so_expression_card` and `p_chain_card` values.

## Notes

Runner decision (reuse -> extend -> new): a **new** `circular-link-propagation`
runner. Reuse was impossible — no existing runner config can express the three
incident-defining elements: (1) circular cross-table dependency (SubOrders ⇄
Purification linked both ways and looking each other up, formulas consuming
those lookups), (2) duplicate sibling one-many links to the same table
doubling the dependency graph, (3) an upward propagation trigger (editing a
scalar cell on the link child, not writing link cells on the host).
Extending was rejected: `link-computed-propagation` hard-codes an acyclic
customer star and measures a link-cell write on the host, and
`computed-chain-mutation` hard-codes an acyclic Users→Orders→Purchases graph
with fixed mutation kinds — grafting a second physical fixture and an
opposite-direction measured operation into either would distort their
contracts and risk their existing cases (`runners.md` says new runner when
extending distorts). The new runner rides `record-mutation-lifecycle` and the
shared helpers, per `new-runner-contract.md`; only the fixture, the measured
window, and the expected-value algebra
(`circular-link-propagation-workload.ts`) are new.

Fingerprint mapping assumptions:

- Row counts rounded: 6,287/3,031/477/3 -> 6,000/3,000/500/3.
- Field totals match the fingerprint (34/85/88/16) and every computed family
  count matches (6 order lookups, 7 purification lookups incl. one over a
  formula, 3 conditional lookups, 8 SubOrders formulas; 14 Purification
  formulas, 18 reverse lookups at 9 text/4 select/4 number/1 link, 8 plasmid
  lookups, 1 order lookup). The production per-type plain-field split (37
  text/16 number/7 select/4 link/2 date) is approximated because the reported
  分项 counts do not sum consistently; plain filler fields keep the same type
  mix and are not asserted.
- Formula expressions are simplified to deterministic string concatenation and
  integer arithmetic (production used `VALUE/TEXTBEFORE/TEXTSPLIT` ratio
  math). The load-bearing property — the dependency edges and the circular
  formula-over-lookup chain — is preserved exactly; the arithmetic itself is
  not what stormed.
- Each sub-order carries at most one purification (injective mapping), so
  one-many lookups hold single-element arrays with exact expected values.
  Production had denser fan-in on some rows.
- Rendering of formulas over _empty_ lookups (unlinked sub-orders) is not
  asserted; those rows prove empty lookups and the purification-independent
  formulas only.
- The measured update is 10 rows in one request; production's storm was
  triggered by an even smaller edit, so 10 gives a stable non-trivial
  propagation set without depending on a single row's timing noise.
