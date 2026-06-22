---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - rollup
  - 4k
  - v1-v2
  - relationship
enabled: true
---

# lookup/dual-link-computed-first-link-4k

## Goal

Measure how long after a data write the V2 dependency graph becomes readable, on
a deep, customer-mirrored schema. After the order links are written, every
dependent lookup, multi-level formula, and downstream cross-table rollup must
recompute. This reproduces the customer "orders" scenario where the links
(`customer_id_fk`, `gust_email_fk`) had record ids immediately but the lookups
(`user_email`, `shipping_first_name`, ...) and the `${first_name} ${last_name}`
formula were still null for a window, producing `undefined undefined`. This
`first-link` variant is the closest to the customer "new record first
association" worst case: orders start with no customer/guest link at all.

The case runs in two computed-update modes (workflow input `computed_update_mode`):

- **sync** (default e2e behavior): V2 computes the graph inside the write
  transaction. The primary metric includes that synchronous write cost plus the
  final readiness check, so V1/V2 compare the same user-visible wait window.
- **hybrid** (production behavior): V2 enqueues the recompute into the
  `computed_update_outbox` and drains it with a polling worker. The primary
  metric includes the faster write response plus the real async propagation
  window, matching the customer's time from write start to correct reads.

## Seed Phase

Mirrors a bounded version of the customer schema across four tables:

- `users` (registered customer) and `guest`, 4,000 rows each, with a `Key`
  primary plus 10 attribute columns (`first_name`, `last_name`, `email`, `phone`,
  `address_1`, `address_2`, `country`, `state`, `postcode`, `city`).
- `orders`, 4,000 rows, with `Title`, two one-way many-one links
  (`customer_id_fk` -> users, `gust_email_fk` -> guest), a two-way many-one
  `purchase_fk` -> purchase, **20 lookups** (10 over each link), and a **4-level
  formula chain** over them: L1 `customer_name`/`guest_name`/`ship_address`/
  `contact` (over lookups), L2 `summary` (over the L1 formulas), L3 `order_card`
  (over `summary`).
- `purchase`, 400 rows, each grouping 10 consecutive orders. It rolls up its
  orders — `p_order_count` (COUNTALL), `p_names` (ARRAY_JOIN of `customer_name`),
  `p_emails` (ARRAY_JOIN of `cust_email`) — and a formula `p_label` over the
  rollup. This is the **second cascade hop**: order computed values feed purchase
  rollups.
- In `first-link` mode orders are seeded with **no** customer/guest link (only
  the static `purchase_fk` grouping), so every lookup, formula, and downstream
  rollup starts empty.
- With seed caching the four tables are named from `seedHash` and built once into
  the seed dump; the seeded order ids and foreign/purchase table ids are
  persisted in the orders table description. `seedReady` revalidates that the
  sample order rows still have empty lookups.

## Execute Phase

1. Verify seed order samples are unlinked (`seedReady`).
2. Execute setup (not measured): scan `users` and `guest` to map titles to ids.
3. `PATCH /api/table/{tableId}/record` (100-row batches; the V1 synchronous
   recompute path times out on larger batches)
   writing both `customer_id_fk` and `gust_email_fk` for every order row `i` to
   foreign row `((i-1)*7+3) % 4000 + 1` (the first links these rows get).
4. The primary timer covers the PATCH batches and then polls a full paged scan of
   all 4,000 orders **and** all 400 purchases until every lookup, formula,
   rollup, and downstream value matches. Assert routing matches the requested
   engine.
5. Cleanup clears the order link cells back to empty on local single-database
   runs; isolated execute databases are discarded by teardown.

## Primary Metric

- `lookupReadyTotalMs`: elapsed time from starting the link write until the
  entire dependency graph (orders lookups + formulas + purchase rollups) reflects
  the new links. This is the user-visible end-to-end wait to read correct
  computed values, and it compares V1's synchronous recompute cost against V2
  hybrid's write-plus-outbox readiness window.

Diagnostics: `linkWriteMs` (the PATCH batches only) and `lookupPropagationMs`
(time after the write response until values are readable). Seeding, the id
scans, and seed validation stay out of the primary metric.

## Verification

- The write responses must update all 4,000 records.
- A full paged scan confirms every customer/guest lookup equals the linked
  foreign attribute and every formula equals its deterministic expected value;
  a purchase scan confirms each `p_order_count` equals its child count, each
  child's `customer_name`/`cust_email` appears in the rollup join, and `p_label`
  matches.

## Notes

Sized at **4,000, not 10,000**, on purpose. In `hybrid` (the production async
path) the recompute window is super-linear and hits a cliff between 4k and 10k —
measured async windows: 300 rows ~7s, 1k ~8.5s, **4k ~20s**, **10k did not
converge within 600s** (perf-lab run 27679497968, V2 hybrid timed out with a
sample order's lookup still `null`). 4k is the largest scale that reliably
converges in both `sync` and `hybrid`, so the case stays green in both modes and
yields a real V2 async number. The 10k async non-convergence is itself a recorded
finding, not a target metric; raising the scale back to 10k would make the hybrid
run a permanent timeout until the V2 outbox drain throughput is optimized.

`maxMs` (120,000) is a coarse guardrail for this high-variance async case, not a
tight SLA. It is kept near the observed worst rather than tightened to ~2x: CI
history (70 v1+v2 runs) shows V1 synchronous recompute running 31-79s and the V2
hybrid path reaching ~117s, so a wide bound is needed to avoid flaking on the
async window. See the `.case.ts` threshold comment for the full rationale.
For a fast local smoke, set `PERF_LAB_LCP_ROWS` / `PERF_LAB_LCP_FOREIGN_ROWS` to
shrink the workload without editing this config.
